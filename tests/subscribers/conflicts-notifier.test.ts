import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import app from '../../src/app.js';
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { resetConfigCache } from '../../src/configuration/cache.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const INSTALLATION_ID = 12345;
const PR_NUMBER = 42;
const NODE_ID = 'IC_abc123';

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

interface PRFetchOverrides {
  user?: { login: string } | null;
  title?: string;
  base?: string;
}

const mockGetPR = (mergeable: boolean | null, overrides: PRFetchOverrides = {}): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/pulls/${PR_NUMBER}`)
    .reply(200, {
      number: PR_NUMBER,
      mergeable,
      mergeable_state: mergeable === true ? 'clean' : mergeable === false ? 'dirty' : 'unknown',
      user: overrides.user === undefined ? { login: 'octocat' } : overrides.user,
      title: overrides.title ?? 'Fix the thing',
      base: { ref: overrides.base ?? 'main' },
      head: { ref: 'feature/widget' },
    });
};

interface GraphqlBody {
  query: string;
  variables?: Record<string, unknown>;
}

const mockCommentsQuery = (
  nodes: { id: string; body: string; isMinimized: boolean }[],
): nock.Scope => {
  return nock('https://api.github.com')
    .post('/graphql', (body: GraphqlBody) => body.query.includes('pullRequest(number'))
    .reply(200, {
      data: {
        repository: { pullRequest: { comments: { nodes } } },
      },
    });
};

const mockMinimize = (subjectId: string): nock.Scope => {
  return nock('https://api.github.com')
    .post('/graphql', (body: GraphqlBody) =>
      body.query.includes('minimizeComment') && body.variables?.['subjectId'] === subjectId,
    )
    .reply(200, {
      data: { minimizeComment: { minimizedComment: { isMinimized: true } } },
    });
};

const mockUnminimize = (subjectId: string): nock.Scope => {
  return nock('https://api.github.com')
    .post('/graphql', (body: GraphqlBody) =>
      body.query.includes('unminimizeComment') && body.variables?.['subjectId'] === subjectId,
    )
    .reply(200, {
      data: { unminimizeComment: { unminimizedComment: { id: subjectId } } },
    });
};

interface PayloadOverrides {
  action?: 'opened' | 'synchronize' | 'reopened';
  user?: { login: string } | null;
  title?: string;
  base?: string;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'synchronize',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    user: overrides.user === undefined ? { login: 'octocat' } : overrides.user,
    title: overrides.title ?? 'Fix the thing',
    base: { ref: overrides.base ?? 'main' },
    head: { ref: 'feature/widget' },
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: 'User' },
});

interface PushOverrides {
  ref?: string;
  senderType?: string;
}

const pushPayload = (overrides: PushOverrides = {}): Record<string, unknown> => ({
  ref: overrides.ref ?? 'refs/heads/main',
  installation: { id: INSTALLATION_ID },
  repository: { owner: { login: 'acme' }, name: 'widgets', default_branch: 'main' },
  sender: { type: overrides.senderType ?? 'User' },
  pusher: { name: 'octocat', email: 'octocat@example.com' },
  before: 'a1b2c3d',
  after: 'e4f5g6h',
  commits: [],
});

const mockListPRsForBase = (
  base: string,
  prs: { number: number; user: { login: string } | null }[],
): nock.Scope => {
  return nock('https://api.github.com')
    .get('/repos/acme/widgets/pulls')
    .query({ base, state: 'open', per_page: '100' })
    .reply(200, prs.map((pr) => ({
      number: pr.number,
      user: pr.user,
      title: `PR #${pr.number}`,
      base: { ref: base },
      head: { ref: `feature/${pr.number}` },
    })));
};

const mockGetPRByNumber = (prNumber: number, mergeable: boolean | null, base = 'main'): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/pulls/${prNumber}`)
    .reply(200, {
      number: prNumber,
      mergeable,
      mergeable_state: mergeable === true ? 'clean' : mergeable === false ? 'dirty' : 'unknown',
      user: { login: 'octocat' },
      title: `PR #${prNumber}`,
      base: { ref: base },
      head: { ref: `feature/${prNumber}` },
    });
};

const CONFIG_ENABLED = 'version: 1\nsubscribers:\n  - conflicts-notifier\n';

describe('conflicts-notifier subscriber (via app)', () => {
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

  it('posts a comment with the default message when a conflict is detected and no existing comment', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(false);
    mockCommentsQuery([]);

    const createScope = nock('https://api.github.com')
      .post(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`, (body: { body: string }) => {
        expect(body.body).toContain('@octocat');
        expect(body.body).toContain('`main`');
        expect(body.body).toContain('<!-- carson:conflicts-notifier -->');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-conflict-new',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('interpolates a custom message with {{user}}, {{repo}}, {{number}}, {{title}} and {{base}}', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - conflicts-notifier',
      'settings:',
      '  conflicts-notifier:',
      '    message: "@{{user}} PR #{{number}} ({{title}}) conflicts with {{base}} on {{repo}}"',
      '',
    ].join('\n'));
    mockGetPR(false);
    mockCommentsQuery([]);

    const createScope = nock('https://api.github.com')
      .post(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`, (body: { body: string }) => {
        expect(body.body).toContain('@octocat PR #42 (Fix the thing) conflicts with main on widgets');
        expect(body.body).toContain('<!-- carson:conflicts-notifier -->');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-conflict-custom',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('unminimizes the existing comment when conflict reappears', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(false);
    mockCommentsQuery([
      { id: NODE_ID, body: 'old message\n\n<!-- carson:conflicts-notifier -->', isMinimized: true },
    ]);
    const unminimizeScope = mockUnminimize(NODE_ID);

    await probot.receive({
      id: 'evt-conflict-reappear',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(unminimizeScope.isDone()).toBe(true);
  });

  it('does nothing when conflict persists and the existing comment is already visible', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(false);
    mockCommentsQuery([
      { id: NODE_ID, body: 'still conflicting\n\n<!-- carson:conflicts-notifier -->', isMinimized: false },
    ]);

    await probot.receive({
      id: 'evt-conflict-persists',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('minimizes the existing comment when the conflict is resolved', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(true);
    mockCommentsQuery([
      { id: NODE_ID, body: 'conflict notice\n\n<!-- carson:conflicts-notifier -->', isMinimized: false },
    ]);
    const minimizeScope = mockMinimize(NODE_ID);

    await probot.receive({
      id: 'evt-conflict-resolved',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(minimizeScope.isDone()).toBe(true);
  });

  it('does nothing when there is no conflict and no existing comment', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(true);
    mockCommentsQuery([]);

    await probot.receive({
      id: 'evt-clean',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when there is no conflict and the existing comment is already minimized', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(true);
    mockCommentsQuery([
      { id: NODE_ID, body: 'resolved notice\n\n<!-- carson:conflicts-notifier -->', isMinimized: true },
    ]);

    await probot.receive({
      id: 'evt-clean-already-minimized',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips when mergeable is still null (GitHub has not computed it yet)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(null);

    await probot.receive({
      id: 'evt-unknown',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when conflicts-notifier is not enabled in carson.yml', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-disabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the sender is a bot', async () => {
    await probot.receive({
      id: 'evt-bot',
      name: 'pull_request',
      payload: { ...prPayload(), sender: { type: 'Bot' } } as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('also fires on pull_request.opened', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(false);
    mockCommentsQuery([]);

    const createScope = nock('https://api.github.com')
      .post(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`).reply(201, {});

    await probot.receive({
      id: 'evt-opened',
      name: 'pull_request',
      payload: prPayload({ action: 'opened' }) as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('does not post when conflict is detected but the PR has no user (ghost)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(false, { user: null });

    await probot.receive({
      id: 'evt-ghost-pr',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('also fires on pull_request.reopened', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockGetPR(false);
    mockCommentsQuery([]);

    const createScope = nock('https://api.github.com')
      .post(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`).reply(201, {});

    await probot.receive({
      id: 'evt-reopened',
      name: 'pull_request',
      payload: prPayload({ action: 'reopened' }) as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('on push to a base branch, scans open PRs and posts a conflict notice on the affected one', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListPRsForBase('main', [{ number: 101, user: { login: 'octocat' } }]);
    mockGetPRByNumber(101, false);
    mockCommentsQuery([]);

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/101/comments').reply(201, {});

    await probot.receive({
      id: 'evt-push-conflict',
      name: 'push',
      payload: pushPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('on push to a base branch, minimizes the existing comment on a PR that is now clean', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListPRsForBase('main', [{ number: 202, user: { login: 'octocat' } }]);
    mockGetPRByNumber(202, true);
    mockCommentsQuery([
      { id: NODE_ID, body: 'old\n\n<!-- carson:conflicts-notifier -->', isMinimized: false },
    ]);
    const minimizeScope = mockMinimize(NODE_ID);

    await probot.receive({
      id: 'evt-push-resolve',
      name: 'push',
      payload: pushPayload() as never,
    });

    expect(minimizeScope.isDone()).toBe(true);
  });

  it('on push to a base branch with no open PRs targeting it, no-ops cheaply', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListPRsForBase('main', []);

    await probot.receive({
      id: 'evt-push-empty',
      name: 'push',
      payload: pushPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips push events for tags (refs/tags/*)', async () => {
    await probot.receive({
      id: 'evt-push-tag',
      name: 'push',
      payload: pushPayload({ ref: 'refs/tags/v1.0.0' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips push events when the sender is a bot', async () => {
    await probot.receive({
      id: 'evt-push-bot',
      name: 'push',
      payload: pushPayload({ senderType: 'Bot' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips push events when conflicts-notifier is not enabled', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-push-disabled',
      name: 'push',
      payload: pushPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});
