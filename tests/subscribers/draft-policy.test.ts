import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import { type ScheduledContext, ScheduledRegistrar } from '../../src/scheduled.js';
import app from '../../src/app.js';
import { DraftPolicySubscriber } from '../../src/subscribers/draft-policy.js';
import { generateKeyPairSync } from 'node:crypto';
import { logger } from '../../src/logger.js';
import nock from 'nock';
import { resetConfigCache } from '../../src/configuration/cache.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const INSTALLATION_ID = 12345;
const PR_NUMBER = 42;
const MARKER = '<!-- carson:draft-policy -->';

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

const mockListComments = (comments: { body: string; userType?: string; nodeId?: string }[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`)
    .query({ per_page: '100' })
    .reply(200, comments.map((c, i) => ({
      id: 100 + i,
      node_id: c.nodeId ?? `IC_${i}`,
      body: c.body,
      created_at: '2025-12-31T00:00:00Z',
      user: { login: c.userType === 'Bot' ? 'carson[bot]' : 'someone', type: c.userType ?? 'User' },
    })));
};

const mockCreateComment = (verify: (body: string) => boolean): nock.Scope => {
  return nock('https://api.github.com')
    .post(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`, (body: { body: string }) => verify(body.body))
    .reply(201, { id: 999 });
};

const mockMinimize = (nodeId: string): nock.Scope => {
  return nock('https://api.github.com')
    .post('/graphql', (body: { query: string; variables: { subjectId: string; classifier: string } }) => {
      expect(body.query).toContain('minimizeComment');
      expect(body.variables).toEqual({ subjectId: nodeId, classifier: 'RESOLVED' });
      return true;
    })
    .reply(200, { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } });
};

const prPayload = (overrides: { action?: 'opened' | 'reopened' | 'converted_to_draft' | 'ready_for_review'; draft?: boolean } = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: overrides.draft ?? true,
    head: { sha: 'abc1234', ref: 'feature/widget' },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: [],
  },
  repository: { owner: { login: 'acme' }, name: 'widgets', default_branch: 'main' },
  sender: { type: 'User' },
});

const CONFIG_ENABLED = 'version: 1\nsubscribers:\n  - draft-policy\n';

describe('draft-policy subscriber (via app)', () => {
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
      privateKey,
      logLevel: 'fatal',
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

  it('comments on a PR opened as draft', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    const createScope = mockCreateComment((body) => {
      expect(body).toContain('Hey @octocat');
      expect(body).toContain('Ready for review');
      expect(body.endsWith(MARKER)).toBe(true);
      return true;
    });

    await probot.receive({
      id: 'evt-dp-draft',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('interpolates a custom message', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - draft-policy',
      'settings:',
      '  draft-policy:',
      '    message: "{{user}} opened {{repo}}#{{number}} as draft"',
      '',
    ].join('\n'));
    const createScope = mockCreateComment((body) => {
      expect(body).toContain('octocat opened widgets#42 as draft');
      return true;
    });

    await probot.receive({
      id: 'evt-dp-custom',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('posts a fresh notice when a PR is converted to draft', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    const createScope = mockCreateComment((body) => body.endsWith(MARKER));

    await probot.receive({
      id: 'evt-dp-converted',
      name: 'pull_request',
      payload: prPayload({ action: 'converted_to_draft' }) as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('posts a fresh notice when a draft PR is reopened', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    const createScope = mockCreateComment((body) => body.endsWith(MARKER));

    await probot.receive({
      id: 'evt-dp-reopened',
      name: 'pull_request',
      payload: prPayload({ action: 'reopened' }) as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('does nothing for a PR opened ready for review', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);

    await probot.receive({
      id: 'evt-dp-not-draft',
      name: 'pull_request',
      payload: prPayload({ draft: false }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('minimizes the notice when the PR is marked ready for review', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListComments([{ body: `notice\n\n${MARKER}`, userType: 'Bot', nodeId: 'IC_notice' }]);
    const minimizeScope = mockMinimize('IC_notice');

    await probot.receive({
      id: 'evt-dp-ready',
      name: 'pull_request',
      payload: prPayload({ action: 'ready_for_review', draft: false }) as never,
    });

    expect(minimizeScope.isDone()).toBe(true);
  });

  it('does nothing on ready_for_review without a notice', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListComments([{ body: `forged\n\n${MARKER}` }]);

    await probot.receive({
      id: 'evt-dp-ready-none',
      name: 'pull_request',
      payload: prPayload({ action: 'ready_for_review', draft: false }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when draft-policy is not enabled', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-dp-disabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});

const NOW = new Date('2026-01-01T00:00:00Z').getTime();
const HOURS_AGO = (hours: number): string => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

interface DraftShape {
  number: number;
  user?: { login: string } | null;
  created_at?: string;
  comments: { body: string; created_at: string; userType?: string }[];
}

interface Harness {
  context: ScheduledContext;
  createCommentMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
}

const makeStubLog = (): Record<string, unknown> => {
  const log: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log['child'] = vi.fn().mockReturnValue(log);

  return log;
};

const makeHarness = (drafts: DraftShape[], config: unknown): Harness => {
  const createCommentMock = vi.fn().mockResolvedValue({});
  const updateMock = vi.fn().mockResolvedValue({});
  const paginate = vi.fn().mockImplementation(async (fn: string, params: { issue_number?: number }) => {
    if (fn === 'search-fn') {
      return await Promise.resolve(drafts.map((d) => ({
        number: d.number,
        title: `Draft #${d.number}`,
        created_at: d.created_at ?? HOURS_AGO(1000),
        user: d.user === undefined ? { login: 'octocat' } : d.user,
        labels: [],
        pull_request: {},
      })));
    }

    const draft = drafts.find((d) => d.number === params.issue_number);

    return await Promise.resolve((draft?.comments ?? []).map((c, i) => ({
      id: i,
      node_id: `IC_${i}`,
      body: c.body,
      created_at: c.created_at,
      user: { login: c.userType === 'Bot' ? 'carson[bot]' : 'someone', type: c.userType ?? 'User' },
    })));
  });

  const context: ScheduledContext = {
    octokit: {
      paginate,
      rest: {
        issues: { createComment: createCommentMock, update: updateMock, listComments: 'list-comments-fn' },
        search: { issuesAndPullRequests: 'search-fn' },
      },
    } as never,
    log: makeStubLog() as never,
    payload: { schedule: '0 * * * *', workflow: '.github/workflows/cron.yml' },
    repo: () => ({ owner: 'acme', repo: 'widgets' }),
    config: vi.fn().mockResolvedValue(config),
  };

  return { context, createCommentMock, updateMock };
};

const runScheduled = async (context: ScheduledContext): Promise<void> => {
  const registrar = new ScheduledRegistrar();
  new DraftPolicySubscriber().registerScheduled(registrar);

  for (const handler of registrar.handlers) {
    await handler(context);
  }
};

const ENABLED = { version: 1, subscribers: ['draft-policy'] };
const NOTICE = (hoursAgo: number): DraftShape['comments'][number] => ({ body: `notice\n\n${MARKER}`, created_at: HOURS_AGO(hoursAgo), userType: 'Bot' });

describe('draft-policy subscriber (scheduled)', () => {
  beforeEach(() => {
    resetConfigCache();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    logger.init(makeStubLog() as never);
  });

  afterEach(() => {
    resetConfigCache();
    logger.reset();
    vi.useRealTimers();
  });

  it('closes a draft whose notice is older than the default 24 hours', async () => {
    const { context, createCommentMock, updateMock } = makeHarness([{ number: 1, comments: [NOTICE(25)] }], ENABLED);

    await runScheduled(context);

    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 1,
      body: expect.stringContaining('more than 24 hours'),
    }));
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 1, state: 'closed' }));
  });

  it('leaves a draft within the grace period open', async () => {
    const { context, createCommentMock, updateMock } = makeHarness([{ number: 1, comments: [NOTICE(23)] }], ENABLED);

    await runScheduled(context);

    expect(createCommentMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('skips a draft opened within the grace period without reading its comments', async () => {
    const { context, updateMock } = makeHarness([{ number: 1, created_at: HOURS_AGO(2), comments: [NOTICE(48)] }], ENABLED);

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
    expect((context.octokit.paginate as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('uses the latest notice as the clock after a PR is re-drafted', async () => {
    const { context, updateMock } = makeHarness([{ number: 1, comments: [NOTICE(48), NOTICE(2)] }], ENABLED);

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('leaves a draft without a notice open', async () => {
    const { context, updateMock } = makeHarness([
      { number: 1, comments: [] },
      { number: 2, comments: [{ body: `forged\n\n${MARKER}`, created_at: HOURS_AGO(48) }] },
    ], ENABLED);

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('honors a custom grace period and close message', async () => {
    const { context, createCommentMock, updateMock } = makeHarness(
      [{ number: 7, user: null, comments: [NOTICE(2)] }],
      { ...ENABLED, settings: { 'draft-policy': { hours_until_close: 1, close_message: 'bye {{repo}}#{{number}} after {{hours}}h' } } },
    );

    await runScheduled(context);

    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({ body: 'bye widgets#7 after 1h' }));
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('never closes when hours_until_close is 0', async () => {
    const { context, updateMock } = makeHarness(
      [{ number: 1, comments: [NOTICE(1000)] }],
      { ...ENABLED, settings: { 'draft-policy': { hours_until_close: 0 } } },
    );

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does nothing when not enabled', async () => {
    const { context, updateMock } = makeHarness([{ number: 1, comments: [NOTICE(48)] }], { version: 1, subscribers: ['stale'] });

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
  });
});
