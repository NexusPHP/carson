import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import { type ScheduledContext, ScheduledRegistrar } from '../../src/scheduled.js';
import app from '../../src/app.js';
import { generateKeyPairSync } from 'node:crypto';
import { logger } from '../../src/logger.js';
import nock from 'nock';
import { resetConfigCache } from '../../src/configuration/cache.js';
import { TriageLabelerSubscriber } from '../../src/subscribers/triage-labeler.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const INSTALLATION_ID = 12345;
const PR_NUMBER = 42;

const mockInstallationToken = (): void => {
  nock('https://api.github.com')
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' });
};

const mockConfig = (yaml: string | null): void => {
  const scope = nock('https://api.github.com');

  if (yaml === null) {
    scope
      .get('/repos/acme/widgets/contents/.github%2Fcarson.yml').reply(404)
      .get('/repos/acme/.github/contents/.github%2Fcarson.yml').reply(404);

    return;
  }

  scope
    .get('/repos/acme/widgets/contents/.github%2Fcarson.yml')
    .reply(200, yaml);
};

interface ReviewInput {
  user: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  commitId?: string;
}

const mockListReviews = (reviews: ReviewInput[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/pulls/${PR_NUMBER}/reviews`)
    .query({ per_page: '100' })
    .reply(200, reviews.map((r, i) => ({
      id: 1000 + i,
      state: r.state,
      user: r.user === null ? null : { login: r.user },
      commit_id: r.commitId ?? 'abc1234',
    })));
};

const mockRole = (login: string, roleName: string | null): nock.Scope => {
  const scope = nock('https://api.github.com').get(`/repos/acme/widgets/collaborators/${login}/permission`);

  return roleName === null
    ? scope.reply(404)
    : scope.reply(200, { permission: 'write', role_name: roleName });
};

const mockAddLabels = (label: string): nock.Scope => {
  return nock('https://api.github.com')
    .post(`/repos/acme/widgets/issues/${PR_NUMBER}/labels`, (body: { labels: string[] }) => {
      expect(body.labels).toEqual([label]);
      return true;
    })
    .reply(200, []);
};

const mockRemoveLabel = (label: string): nock.Scope => {
  return nock('https://api.github.com')
    .delete(`/repos/acme/widgets/issues/${PR_NUMBER}/labels/${encodeURIComponent(label)}`)
    .reply(200, []);
};

interface PayloadOverrides {
  action?: 'opened' | 'reopened' | 'synchronize' | 'ready_for_review' | 'converted_to_draft';
  reviewAction?: 'submitted' | 'dismissed';
  draft?: boolean;
  labels?: string[];
  senderType?: string;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: overrides.draft ?? false,
    head: { sha: 'abc1234', ref: 'feature/widget' },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
});

const reviewPayload = (
  reviewState: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED',
  reviewer: string,
  overrides: PayloadOverrides = {},
): Record<string, unknown> => ({
  action: overrides.reviewAction ?? 'submitted',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: overrides.draft ?? false,
    head: { sha: 'abc1234', ref: 'feature/widget' },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
  },
  review: {
    state: reviewState.toLowerCase(),
    user: { login: reviewer },
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User', login: reviewer },
});

const CONFIG_ENABLED = 'version: 1\nsubscribers:\n  - triage-labeler\n';
const CONFIG_RESET_ON_PUSH = `${CONFIG_ENABLED}settings:\n  triage-labeler:\n    reset_on_push: true\n`;

describe('triage-labeler subscriber (via app)', () => {
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

  it('does nothing when triage-labeler is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - issue-intake\n');

    await probot.receive({
      id: 'evt-not-enabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('adds needs-review on a non-draft opened PR with no reviews', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-opened',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does not label an opened draft PR', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);

    await probot.receive({
      id: 'evt-opened-draft',
      name: 'pull_request',
      payload: prPayload({ draft: true }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('adds needs-review on ready_for_review when no reviews exist', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-ready',
      name: 'pull_request',
      payload: prPayload({ action: 'ready_for_review' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('removes the existing managed label when converted to draft', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    const removeScope = mockRemoveLabel('needs-review');

    await probot.receive({
      id: 'evt-converted-draft',
      name: 'pull_request',
      payload: prPayload({
        action: 'converted_to_draft',
        draft: true,
        labels: ['needs-review', 'bug'],
      }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('sets needs-rework when a qualifying reviewer requests changes', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'CHANGES_REQUESTED' }]);
    mockRole('alice', 'write');
    const removeScope = mockRemoveLabel('needs-review');
    const addScope = mockAddLabels('needs-rework');

    await probot.receive({
      id: 'evt-changes-requested',
      name: 'pull_request_review',
      payload: reviewPayload('CHANGES_REQUESTED', 'alice', { labels: ['needs-review'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('returns to needs-review when the standing change request is dismissed', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'DISMISSED' }]);
    const removeScope = mockRemoveLabel('needs-rework');
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-dismissed',
      name: 'pull_request_review',
      payload: reviewPayload('CHANGES_REQUESTED', 'alice', { reviewAction: 'dismissed', labels: ['needs-rework'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('sets approved when the only qualifying review is APPROVED', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'APPROVED' }]);
    mockRole('alice', 'admin');
    const removeScope = mockRemoveLabel('needs-review');
    const addScope = mockAddLabels('approved');

    await probot.receive({
      id: 'evt-approved',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['needs-review'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('keeps needs-rework when one reviewer approves but anothers latest is CHANGES_REQUESTED', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: 'alice', state: 'CHANGES_REQUESTED' },
      { user: 'bob', state: 'APPROVED' },
    ]);
    mockRole('alice', 'maintain');
    mockRole('bob', 'write');

    await probot.receive({
      id: 'evt-mixed',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'bob', { labels: ['needs-rework'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('uses the latest review per reviewer (later APPROVED overrides earlier CHANGES_REQUESTED)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: 'alice', state: 'CHANGES_REQUESTED' },
      { user: 'alice', state: 'APPROVED' },
    ]);
    mockRole('alice', 'write');
    const removeScope = mockRemoveLabel('needs-rework');
    const addScope = mockAddLabels('approved');

    await probot.receive({
      id: 'evt-later-wins',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['needs-rework'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('ignores reviews from users without a qualifying role', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: 'eve', state: 'APPROVED' },
      { user: 'mallory', state: 'CHANGES_REQUESTED' },
    ]);
    mockRole('eve', 'read');
    mockRole('mallory', null);

    await probot.receive({
      id: 'evt-non-qualifying',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'eve', { labels: ['needs-review'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores reviews from deleted accounts (user is null)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: null, state: 'APPROVED' },
    ]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-ghost-reviewer',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: [] }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('ignores COMMENTED reviews when computing state', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: 'alice', state: 'COMMENTED' },
    ]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-commented',
      name: 'pull_request_review',
      payload: reviewPayload('COMMENTED', 'alice', { labels: [] }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does not touch unrelated labels', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'APPROVED' }]);
    mockRole('alice', 'write');
    const removeScope = mockRemoveLabel('needs-review');
    const addScope = mockAddLabels('approved');

    await probot.receive({
      id: 'evt-untouched',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['bug', 'area:api', 'needs-review'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('honors custom label name overrides', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - triage-labeler',
      'settings:',
      '  triage-labeler:',
      '    needs_review_label: "status: needs review"',
      '    needs_rework_label: "status: changes requested"',
      '    approved_label: "status: ready to merge"',
      '',
    ].join('\n'));
    mockListReviews([]);
    const addScope = mockAddLabels('status: needs review');

    await probot.receive({
      id: 'evt-custom-labels',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('labels a PR opened by a bot', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-bot',
      name: 'pull_request',
      payload: prPayload({ senderType: 'Bot' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('honors a narrowed qualifying_roles set', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - triage-labeler',
      'settings:',
      '  triage-labeler:',
      '    qualifying_roles: [admin]',
      '',
    ].join('\n'));
    mockListReviews([{ user: 'alice', state: 'APPROVED' }]);
    mockRole('alice', 'write');

    await probot.receive({
      id: 'evt-narrowed-roles',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['needs-review'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('keeps needs-rework after a push by default even when the change request is stale', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'CHANGES_REQUESTED', commitId: 'older00' }]);
    mockRole('alice', 'write');

    await probot.receive({
      id: 'evt-stale-default',
      name: 'pull_request',
      payload: prPayload({ action: 'synchronize', labels: ['needs-rework'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('returns to needs-review after a push when reset_on_push is set and the change request is stale', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_RESET_ON_PUSH);
    mockListReviews([{ user: 'alice', state: 'CHANGES_REQUESTED', commitId: 'older00' }]);
    const removeScope = mockRemoveLabel('needs-rework');
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-reset-stale',
      name: 'pull_request',
      payload: prPayload({ action: 'synchronize', labels: ['needs-rework'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('keeps needs-rework under reset_on_push when the change request targets the current head', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_RESET_ON_PUSH);
    mockListReviews([{ user: 'alice', state: 'CHANGES_REQUESTED' }]);
    mockRole('alice', 'write');

    await probot.receive({
      id: 'evt-reset-fresh',
      name: 'pull_request',
      payload: prPayload({ action: 'synchronize', labels: ['needs-rework'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does not resurrect an earlier approval when a stale change request is dropped', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_RESET_ON_PUSH);
    mockListReviews([
      { user: 'alice', state: 'APPROVED', commitId: 'older00' },
      { user: 'alice', state: 'CHANGES_REQUESTED', commitId: 'older01' },
    ]);
    const removeScope = mockRemoveLabel('needs-rework');
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-reset-no-resurrect',
      name: 'pull_request',
      payload: prPayload({ action: 'synchronize', labels: ['needs-rework'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('ignores the removed qualifying_associations setting and warns', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - triage-labeler',
      'settings:',
      '  triage-labeler:',
      '    qualifying_associations: [OWNER, MEMBER]',
      '',
    ].join('\n'));
    mockListReviews([{ user: 'alice', state: 'APPROVED' }]);
    mockRole('alice', 'write');
    const removeScope = mockRemoveLabel('needs-review');
    const addScope = mockAddLabels('approved');

    await probot.receive({
      id: 'evt-legacy-associations',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['needs-review'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('makes no label API calls when the existing managed label already matches desired', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'APPROVED' }]);
    mockRole('alice', 'write');

    await probot.receive({
      id: 'evt-idempotent',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['approved'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({
      id: 'evt-missing',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});

interface OpenPr {
  number: number;
  labels?: string[];
  draft?: boolean;
  sha?: string;
}

interface SweepReview {
  state: string;
  login: string;
  commit_id?: string;
}

interface SweepHarness {
  context: ScheduledContext;
  addLabelsMock: ReturnType<typeof vi.fn>;
  removeLabelMock: ReturnType<typeof vi.fn>;
  permissionMock: ReturnType<typeof vi.fn>;
  paginateMock: ReturnType<typeof vi.fn>;
}

const makeStubLog = (): Record<string, unknown> => {
  const log: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log['child'] = vi.fn().mockReturnValue(log);

  return log;
};

const makeSweepHarness = (prs: OpenPr[], reviews: Record<number, SweepReview[]>, config: unknown): SweepHarness => {
  const addLabelsMock = vi.fn().mockResolvedValue({});
  const removeLabelMock = vi.fn().mockResolvedValue({});
  const permissionMock = vi.fn().mockImplementation(async ({ username }: { username: string }) =>
    await Promise.resolve({ data: { role_name: username === 'outsider' ? 'read' : 'write' } }),
  );
  const paginateMock = vi.fn().mockImplementation(async (fn: string, params: { pull_number?: number }) => {
    if (fn === 'list-fn') {
      return await Promise.resolve(prs.map((pr) => ({
        number: pr.number,
        draft: pr.draft ?? false,
        labels: (pr.labels ?? []).map((name) => ({ name })),
        head: { sha: pr.sha ?? 'head-sha' },
      })));
    }

    return await Promise.resolve((reviews[params.pull_number ?? 0] ?? []).map((review) => ({
      state: review.state,
      user: { login: review.login },
      commit_id: review.commit_id ?? 'head-sha',
    })));
  });

  const context: ScheduledContext = {
    octokit: {
      paginate: paginateMock,
      rest: {
        pulls: { list: 'list-fn', listReviews: 'reviews-fn' },
        issues: { addLabels: addLabelsMock, removeLabel: removeLabelMock },
        repos: { getCollaboratorPermissionLevel: permissionMock },
      },
    } as never,
    log: makeStubLog() as never,
    payload: { schedule: '0 * * * *', workflow: '.github/workflows/cron.yml' },
    repo: () => ({ owner: 'acme', repo: 'widgets' }),
    config: vi.fn().mockResolvedValue(config),
  };

  return { context, addLabelsMock, removeLabelMock, permissionMock, paginateMock };
};

const runSweep = async (context: ScheduledContext): Promise<void> => {
  const registrar = new ScheduledRegistrar();

  new TriageLabelerSubscriber().registerScheduled(registrar);

  for (const handler of registrar.handlers) {
    await handler(context);
  }
};

const sweepConfig = (settings: Record<string, unknown> = { sweep: true }): unknown => ({
  version: 1,
  subscribers: ['triage-labeler'],
  settings: { 'triage-labeler': settings },
});

describe('triage-labeler subscriber (scheduled sweep)', () => {
  let stubLog: Record<string, unknown>;

  beforeEach(() => {
    resetConfigCache();
    stubLog = makeStubLog();
    logger.init(stubLog as never);
  });

  afterEach(() => {
    logger.reset();
  });

  it('adds the missing label to an open pull request an event never reached', async () => {
    const { context, addLabelsMock, removeLabelMock } = makeSweepHarness([{ number: 13 }], {}, sweepConfig());

    await runSweep(context);

    expect(addLabelsMock).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', issue_number: 13, labels: ['needs-review'] });
    expect(removeLabelMock).not.toHaveBeenCalled();
    expect(stubLog['info']).toHaveBeenCalledWith('Reconciled 1 of 1 open PR');
  });

  it('applies a review that arrived while the event could not be handled', async () => {
    const { context, addLabelsMock, removeLabelMock } = makeSweepHarness(
      [{ number: 7, labels: ['needs-review', 'bug'] }],
      { 7: [{ state: 'APPROVED', login: 'maintainer' }] },
      sweepConfig(),
    );

    await runSweep(context);

    expect(removeLabelMock).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', issue_number: 7, name: 'needs-review' });
    expect(addLabelsMock).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', issue_number: 7, labels: ['approved'] });
  });

  it('leaves pull requests that are already correct untouched', async () => {
    const { context, addLabelsMock, removeLabelMock } = makeSweepHarness(
      [{ number: 1, labels: ['needs-review'] }, { number: 2, labels: ['approved'] }],
      { 2: [{ state: 'APPROVED', login: 'maintainer' }] },
      sweepConfig(),
    );

    await runSweep(context);

    expect(addLabelsMock).not.toHaveBeenCalled();
    expect(removeLabelMock).not.toHaveBeenCalled();
    expect(stubLog['info']).toHaveBeenCalledWith('Reconciled 0 of 2 open PRs');
  });

  it('removes a managed label from a draft without reading its reviews', async () => {
    const { context, removeLabelMock, paginateMock } = makeSweepHarness([{ number: 5, draft: true, labels: ['needs-review'] }], {}, sweepConfig());

    await runSweep(context);

    expect(removeLabelMock).toHaveBeenCalledTimes(1);
    expect(paginateMock).toHaveBeenCalledTimes(1);
  });

  it('ignores reviews from reviewers without a qualifying role', async () => {
    const { context, addLabelsMock } = makeSweepHarness(
      [{ number: 9, labels: ['needs-review'] }],
      { 9: [{ state: 'APPROVED', login: 'outsider' }] },
      sweepConfig(),
    );

    await runSweep(context);

    expect(addLabelsMock).not.toHaveBeenCalled();
  });

  it('looks up each reviewer role once per run', async () => {
    const approved = [{ state: 'APPROVED', login: 'maintainer' }];
    const { context, permissionMock } = makeSweepHarness(
      [{ number: 1 }, { number: 2 }, { number: 3 }],
      { 1: approved, 2: approved, 3: approved },
      sweepConfig(),
    );

    await runSweep(context);

    expect(permissionMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing by default', async () => {
    const { context, paginateMock } = makeSweepHarness([{ number: 13 }], {}, sweepConfig({}));

    await runSweep(context);

    expect(paginateMock).not.toHaveBeenCalled();
  });

  it('does nothing when sweep is false', async () => {
    const { context, paginateMock } = makeSweepHarness([{ number: 13 }], {}, sweepConfig({ sweep: false }));

    await runSweep(context);

    expect(paginateMock).not.toHaveBeenCalled();
  });

  it('does nothing when triage-labeler is not enabled', async () => {
    const { context, paginateMock } = makeSweepHarness([{ number: 13 }], {}, { version: 1, subscribers: ['issue-intake'] });

    await runSweep(context);

    expect(paginateMock).not.toHaveBeenCalled();
  });
});
