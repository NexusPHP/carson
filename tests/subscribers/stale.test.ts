import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import { resetConfigCache, setRegisteredSubscribers } from '../../src/configuration/cache.js';
import { type ScheduledContext, ScheduledRegistrar } from '../../src/scheduled.js';
import app from '../../src/app.js';
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { StaleSubscriber } from '../../src/subscribers/stale.js';

interface ItemShape {
  number: number;
  updated_at: string;
  labels?: ({ name: string } | string)[];
  user?: { login: string } | null;
  title?: string;
  pull_request?: { url: string };
}

interface Harness {
  context: ScheduledContext;
  addLabelsMock: ReturnType<typeof vi.fn>;
  createCommentMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
}

const NOW = new Date('2026-01-01T00:00:00Z').getTime();
const DAYS_AGO = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const makeHarness = (items: ItemShape[], config: unknown): Harness => {
  const addLabelsMock = vi.fn().mockResolvedValue({});
  const createCommentMock = vi.fn().mockResolvedValue({});
  const updateMock = vi.fn().mockResolvedValue({});
  const configMock = vi.fn().mockResolvedValue(config);

  const paginate = vi.fn().mockResolvedValue(items.map((i) => ({
    number: i.number,
    title: i.title ?? `Item #${i.number}`,
    updated_at: i.updated_at,
    labels: i.labels ?? [],
    user: i.user === undefined ? { login: 'octocat' } : i.user,
    pull_request: i.pull_request,
  })));

  const context: ScheduledContext = {
    octokit: {
      paginate,
      rest: {
        issues: {
          listForRepo: 'listForRepo-fn',
          addLabels: addLabelsMock,
          createComment: createCommentMock,
          update: updateMock,
        },
      },
    } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    payload: { schedule: '0 * * * *', workflow: '.github/workflows/cron.yml' },
    repo: () => ({ owner: 'acme', repo: 'widgets' }),
    config: configMock,
  };

  return { context, addLabelsMock, createCommentMock, updateMock };
};

const runScheduled = async (context: ScheduledContext): Promise<void> => {
  const subscriber = new StaleSubscriber();
  const registrar = new ScheduledRegistrar();
  subscriber.registerScheduled(registrar);
  for (const handler of registrar.handlers) {
    await handler(context);
  }
};

const ENABLED = { version: 1, subscribers: ['stale'] };

describe('stale subscriber', () => {
  beforeEach(() => {
    setRegisteredSubscribers(['stale']);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    resetConfigCache();
    setRegisteredSubscribers([]);
    vi.useRealTimers();
  });

  it('marks an inactive issue stale: applies label + posts message with marker and {{type}} = issue', async () => {
    const { context, addLabelsMock, createCommentMock, updateMock } = makeHarness(
      [{ number: 1, updated_at: DAYS_AGO(70) }],
      ENABLED,
    );

    await runScheduled(context);

    expect(addLabelsMock).toHaveBeenCalledWith({
      owner: 'acme', repo: 'widgets', issue_number: 1, labels: ['stale'],
    });
    const commentBody = createCommentMock.mock.calls[0]?.[0].body as string;
    expect(commentBody).toContain('This issue has been inactive for 60 days');
    expect(commentBody).toContain('<!-- carson:stale -->');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('marks an inactive PR stale: posts message with {{type}} = pull request', async () => {
    const { context, addLabelsMock, createCommentMock } = makeHarness(
      [{ number: 2, updated_at: DAYS_AGO(70), pull_request: { url: 'https://example/2' } }],
      ENABLED,
    );

    await runScheduled(context);

    expect(addLabelsMock).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 2 }));
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('This pull request has been inactive'),
    }));
  });

  it('closes a stale-labeled issue past the close window: posts close message + sets state closed', async () => {
    const { context, addLabelsMock, createCommentMock, updateMock } = makeHarness(
      [{ number: 3, updated_at: DAYS_AGO(10), labels: [{ name: 'stale' }] }],
      ENABLED,
    );

    await runScheduled(context);

    expect(addLabelsMock).not.toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 3,
      body: 'Closing this issue due to extended inactivity.',
    }));
    expect(updateMock).toHaveBeenCalledWith({
      owner: 'acme', repo: 'widgets', issue_number: 3, state: 'closed',
    });
    const [commentOrder] = createCommentMock.mock.invocationCallOrder;
    const [updateOrder] = updateMock.mock.invocationCallOrder;
    expect(commentOrder).toBeDefined();
    expect(updateOrder).toBeDefined();
    expect(commentOrder).toBeLessThan(updateOrder as number);
  });

  it('skips a stale-labeled item still within the close window', async () => {
    const { context, updateMock, addLabelsMock } = makeHarness(
      [{ number: 4, updated_at: DAYS_AGO(3), labels: ['stale'] }],
      ENABLED,
    );

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
    expect(addLabelsMock).not.toHaveBeenCalled();
  });

  it('skips a fresh item that is neither stale nor inactive', async () => {
    const { context, addLabelsMock, createCommentMock, updateMock } = makeHarness(
      [{ number: 5, updated_at: DAYS_AGO(10) }],
      ENABLED,
    );

    await runScheduled(context);

    expect(addLabelsMock).not.toHaveBeenCalled();
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('skips items carrying an exempt label', async () => {
    const { context, addLabelsMock, updateMock } = makeHarness(
      [{ number: 6, updated_at: DAYS_AGO(100), labels: ['pinned'] }],
      { ...ENABLED, settings: { stale: { exempt_labels: ['pinned'] } } },
    );

    await runScheduled(context);

    expect(addLabelsMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('honors a custom days_until_stale', async () => {
    const { context, addLabelsMock } = makeHarness(
      [
        { number: 7, updated_at: DAYS_AGO(40) },
        { number: 8, updated_at: DAYS_AGO(20) },
      ],
      { ...ENABLED, settings: { stale: { days_until_stale: 30 } } },
    );

    await runScheduled(context);

    expect(addLabelsMock).toHaveBeenCalledTimes(1);
    expect(addLabelsMock).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 7 }));
  });

  it('honors a custom stale_label name', async () => {
    const { context, addLabelsMock } = makeHarness(
      [{ number: 9, updated_at: DAYS_AGO(100) }],
      { ...ENABLED, settings: { stale: { stale_label: 'inactive' } } },
    );

    await runScheduled(context);

    expect(addLabelsMock).toHaveBeenCalledWith(expect.objectContaining({ labels: ['inactive'] }));
  });

  it('interpolates user/number/repo/title/days_inactive/days_until_close in stale_message', async () => {
    const { context, createCommentMock } = makeHarness(
      [{ number: 10, updated_at: DAYS_AGO(70), title: 'Add new thing' }],
      {
        ...ENABLED,
        settings: {
          stale: {
            stale_message: '@{{user}} #{{number}} ({{title}}) on {{repo}} inactive {{days_inactive}}d, closing in {{days_until_close}}d.',
          },
        },
      },
    );

    await runScheduled(context);

    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('@octocat #10 (Add new thing) on widgets inactive 60d, closing in 7d.'),
    }));
  });

  it('uses a custom close_message when configured', async () => {
    const { context, createCommentMock } = makeHarness(
      [{ number: 11, updated_at: DAYS_AGO(10), labels: ['stale'] }],
      {
        ...ENABLED,
        settings: { stale: { close_message: 'Bye @{{user}} - {{type}} #{{number}}' } },
      },
    );

    await runScheduled(context);

    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Bye @octocat - issue #11',
    }));
  });

  it('leaves {{user}} verbatim when the item has no user (ghost)', async () => {
    const { context, createCommentMock } = makeHarness(
      [{ number: 12, updated_at: DAYS_AGO(70), user: null }],
      {
        ...ENABLED,
        settings: { stale: { stale_message: 'Hi @{{user}}, #{{number}}' } },
      },
    );

    await runScheduled(context);

    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('Hi @{{user}}, #12'),
    }));
  });

  it('does nothing when stale is not enabled', async () => {
    const { context, addLabelsMock, updateMock } = makeHarness(
      [{ number: 13, updated_at: DAYS_AGO(100), labels: ['stale'] }],
      { version: 1, subscribers: ['welcome'] },
    );

    await runScheduled(context);

    expect(addLabelsMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does nothing when carson.yml is missing', async () => {
    const { context, addLabelsMock, updateMock } = makeHarness(
      [{ number: 14, updated_at: DAYS_AGO(100) }],
      null,
    );

    await runScheduled(context);

    expect(addLabelsMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('registers webhook handlers for activity events (un-stale path)', () => {
    const subscriber = new StaleSubscriber();
    const onSpy = vi.fn();
    subscriber.register({ on: onSpy } as never);
    expect(onSpy).toHaveBeenCalledTimes(3);
    expect(onSpy.mock.calls[0]?.[0]).toEqual(['issue_comment.created', 'issues.edited']);
    expect(onSpy.mock.calls[1]?.[0]).toEqual(['pull_request.synchronize', 'pull_request.edited']);
    expect(onSpy.mock.calls[2]?.[0]).toBe('pull_request_review.submitted');
  });
});

const { privateKey: WEBHOOK_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const INSTALLATION_ID = 12345;

const mockInstallationToken = (): void => {
  nock('https://api.github.com')
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' });
};

const mockConfig = (yaml: string): void => {
  nock('https://api.github.com')
    .get('/repos/acme/widgets/contents/.github%2Fcarson.yml')
    .reply(200, yaml);
};

const mockRemoveLabel = (issueNumber: number, label: string): nock.Scope => {
  return nock('https://api.github.com')
    .delete(`/repos/acme/widgets/issues/${issueNumber}/labels/${encodeURIComponent(label)}`)
    .reply(200, []);
};

const mockListComments = (
  issueNumber: number,
  comments: { node_id: string; body: string }[],
): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/issues/${issueNumber}/comments`)
    .query({ per_page: '100' })
    .reply(200, comments);
};

interface GraphqlBody {
  query: string;
  variables?: Record<string, unknown>;
}

const mockMinimize = (subjectId: string): nock.Scope => {
  return nock('https://api.github.com')
    .post('/graphql', (body: GraphqlBody) =>
      body.query.includes('minimizeComment') && body.variables?.['subjectId'] === subjectId,
    )
    .reply(200, {
      data: { minimizeComment: { minimizedComment: { isMinimized: true } } },
    });
};

const issueCommentPayload = (overrides: {
  labels?: { name: string }[] | null;
  senderType?: string;
  issueNumber?: number;
} = {}): Record<string, unknown> => {
  const issue: Record<string, unknown> = {
    number: overrides.issueNumber ?? 42,
    user: { login: 'octocat' },
    title: 'Some issue',
  };

  if (overrides.labels !== null) {
    issue['labels'] = overrides.labels ?? [{ name: 'stale' }];
  }

  return {
    action: 'created',
    installation: { id: INSTALLATION_ID },
    comment: { id: 1, body: 'hi' },
    issue,
    repository: { owner: { login: 'acme' }, name: 'widgets' },
    sender: { type: overrides.senderType ?? 'User', login: 'octocat' },
  };
};

const prSynchronizePayload = (overrides: {
  labels?: { name: string }[];
  senderType?: string;
  senderLogin?: string;
} = {}): Record<string, unknown> => ({
  action: 'synchronize',
  installation: { id: INSTALLATION_ID },
  number: 42,
  pull_request: {
    number: 42,
    labels: overrides.labels ?? [{ name: 'stale' }],
    user: { login: 'octocat' },
    title: 'Some PR',
    base: { ref: 'main' },
    head: { ref: 'feature' },
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User', login: overrides.senderLogin ?? 'octocat' },
  before: 'a',
  after: 'b',
});

const CONFIG_STALE_ENABLED = 'version: 1\nsubscribers:\n  - stale\n';

describe('stale subscriber (webhook un-stale)', () => {
  let probot: Probot;

  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    resetConfigCache();
    probot = new Probot({
      appId: 123,
      privateKey: WEBHOOK_PRIVATE_KEY,
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    await probot.load(app);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('removes the stale label on issue_comment.created when the issue is stale', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_STALE_ENABLED);
    const removeScope = mockRemoveLabel(42, 'stale');
    mockListComments(42, [{ node_id: 'C_abc', body: 'old notice\n\n<!-- carson:stale -->' }]);
    const minimizeScope = mockMinimize('C_abc');

    await probot.receive({
      id: 'evt-unstale-comment',
      name: 'issue_comment',
      payload: issueCommentPayload() as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(minimizeScope.isDone()).toBe(true);
  });

  it('removes the stale label on pull_request.synchronize when the PR is stale', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_STALE_ENABLED);
    const removeScope = mockRemoveLabel(42, 'stale');
    mockListComments(42, [{ node_id: 'C_def', body: 'old notice\n\n<!-- carson:stale -->' }]);
    const minimizeScope = mockMinimize('C_def');

    await probot.receive({
      id: 'evt-unstale-pr-sync',
      name: 'pull_request',
      payload: prSynchronizePayload() as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(minimizeScope.isDone()).toBe(true);
  });

  it('respects a custom stale_label setting', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - stale',
      'settings:',
      '  stale:',
      '    stale_label: inactive',
      '',
    ].join('\n'));
    const removeScope = mockRemoveLabel(42, 'inactive');
    mockListComments(42, []);

    await probot.receive({
      id: 'evt-unstale-custom-label',
      name: 'issue_comment',
      payload: issueCommentPayload({ labels: [{ name: 'inactive' }] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
  });

  it('does not minimize anything when there is no Carson stale comment to find (legacy item)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_STALE_ENABLED);
    const removeScope = mockRemoveLabel(42, 'stale');
    mockListComments(42, [{ node_id: 'C_other', body: 'unrelated comment, no marker' }]);

    await probot.receive({
      id: 'evt-unstale-no-marker',
      name: 'issue_comment',
      payload: issueCommentPayload() as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the item has no stale label', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_STALE_ENABLED);

    await probot.receive({
      id: 'evt-no-stale-label',
      name: 'issue_comment',
      payload: issueCommentPayload({ labels: [{ name: 'bug' }] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips when the sender is a bot (Dependabot rebase etc.)', async () => {
    await probot.receive({
      id: 'evt-bot-sender',
      name: 'pull_request',
      payload: prSynchronizePayload({ senderType: 'Bot', senderLogin: 'dependabot[bot]' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when stale is not enabled in carson.yml', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-disabled',
      name: 'issue_comment',
      payload: issueCommentPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the payload omits labels (defensive undefined handling)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_STALE_ENABLED);

    await probot.receive({
      id: 'evt-no-labels-field',
      name: 'issue_comment',
      payload: issueCommentPayload({ labels: null }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('removes the stale label on pull_request_review.submitted', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_STALE_ENABLED);
    const scope = mockRemoveLabel(42, 'stale');
    mockListComments(42, []);

    await probot.receive({
      id: 'evt-review-submitted',
      name: 'pull_request_review',
      payload: {
        action: 'submitted',
        installation: { id: INSTALLATION_ID },
        review: { id: 1, state: 'approved' },
        pull_request: {
          number: 42,
          labels: [{ name: 'stale' }],
          user: { login: 'octocat' },
          title: 'Some PR',
          base: { ref: 'main' },
          head: { ref: 'feature' },
        },
        repository: { owner: { login: 'acme' }, name: 'widgets' },
        sender: { type: 'User', login: 'reviewer' },
      } as never,
    });

    expect(scope.isDone()).toBe(true);
  });
});
