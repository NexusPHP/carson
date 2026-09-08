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
const MARKER = '<!-- carson:unsupported-branch -->';

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

interface CommentInput {
  body: string;
  userType?: string;
  nodeId?: string;
}

const mockListComments = (comments: CommentInput[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`)
    .query({ per_page: '100' })
    .reply(200, comments.map((c, i) => ({
      id: 100 + i,
      node_id: c.nodeId ?? `IC_${i}`,
      body: c.body,
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
      expect(body.variables).toEqual({ subjectId: nodeId, classifier: 'OUTDATED' });
      return true;
    })
    .reply(200, { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } });
};

interface PayloadOverrides {
  action?: 'opened' | 'ready_for_review' | 'edited';
  draft?: boolean;
  base?: string;
  changes?: Record<string, unknown>;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: overrides.draft ?? false,
    head: { sha: 'abc1234', ref: 'feature/widget' },
    base: { ref: overrides.base ?? '0.9' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: [],
  },
  ...(overrides.changes === undefined ? {} : { changes: overrides.changes }),
  repository: { owner: { login: 'acme' }, name: 'widgets', default_branch: 'main' },
  sender: { type: 'User' },
});

const configWith = (extra: string[] = []): string => [
  'version: 1',
  'subscribers:',
  '  - unsupported-branch',
  'settings:',
  '  unsupported-branch:',
  '    branches: [1.x, 2.x]',
  ...extra,
  '',
].join('\n');

describe('unsupported-branch subscriber (via app)', () => {
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

  it('comments with the default message when the base branch is not maintained', async () => {
    mockInstallationToken();
    mockConfig(configWith());
    mockListComments([]);
    const createScope = mockCreateComment((body) => {
      expect(body).toContain('Hey @octocat');
      expect(body).toContain('`0.9`');
      expect(body).toContain('`1.x`, `2.x`');
      expect(body.endsWith(MARKER)).toBe(true);
      return true;
    });

    await probot.receive({
      id: 'evt-ub-post',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('interpolates a custom message', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    message: "{{repo}}#{{number}} targets {{base}}, use {{branches}}"']));
    mockListComments([]);
    const createScope = mockCreateComment((body) => {
      expect(body).toContain('widgets#42 targets 0.9, use `1.x`, `2.x`');
      return true;
    });

    await probot.receive({
      id: 'evt-ub-custom',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('does nothing when the base branch is maintained', async () => {
    mockInstallationToken();
    mockConfig(configWith());
    mockListComments([]);

    await probot.receive({
      id: 'evt-ub-maintained',
      name: 'pull_request',
      payload: prPayload({ base: '1.x' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('always allows the default branch', async () => {
    mockInstallationToken();
    mockConfig(configWith());
    mockListComments([]);

    await probot.receive({
      id: 'evt-ub-default',
      name: 'pull_request',
      payload: prPayload({ base: 'main' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does not post a second notice when one already exists', async () => {
    mockInstallationToken();
    mockConfig(configWith());
    mockListComments([{ body: `earlier notice\n\n${MARKER}`, userType: 'Bot' }]);

    await probot.receive({
      id: 'evt-ub-dupe',
      name: 'pull_request',
      payload: prPayload({ action: 'ready_for_review' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores a forged marker from a non-bot comment', async () => {
    mockInstallationToken();
    mockConfig(configWith());
    mockListComments([{ body: `forged\n\n${MARKER}` }]);
    const createScope = mockCreateComment(() => true);

    await probot.receive({
      id: 'evt-ub-forged',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('minimizes the notice when the PR is retargeted to a maintained branch', async () => {
    mockInstallationToken();
    mockConfig(configWith());
    mockListComments([{ body: `notice\n\n${MARKER}`, userType: 'Bot', nodeId: 'IC_notice' }]);
    const minimizeScope = mockMinimize('IC_notice');

    await probot.receive({
      id: 'evt-ub-retarget-ok',
      name: 'pull_request',
      payload: prPayload({
        action: 'edited',
        base: '2.x',
        changes: { base: { ref: { from: '0.9' }, sha: { from: 'old' } } },
      }) as never,
    });

    expect(minimizeScope.isDone()).toBe(true);
  });

  it('posts when the PR is retargeted to an unmaintained branch', async () => {
    mockInstallationToken();
    mockConfig(configWith());
    mockListComments([]);
    const createScope = mockCreateComment(() => true);

    await probot.receive({
      id: 'evt-ub-retarget-bad',
      name: 'pull_request',
      payload: prPayload({
        action: 'edited',
        base: '0.8',
        changes: { base: { ref: { from: '1.x' }, sha: { from: 'old' } } },
      }) as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('ignores edits that do not change the base branch', async () => {
    mockInstallationToken();
    mockConfig(configWith());

    await probot.receive({
      id: 'evt-ub-edit-title',
      name: 'pull_request',
      payload: prPayload({ action: 'edited', changes: { title: { from: 'old' } } }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips draft PRs', async () => {
    mockInstallationToken();
    mockConfig(configWith());

    await probot.receive({
      id: 'evt-ub-draft',
      name: 'pull_request',
      payload: prPayload({ draft: true }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when no branches are configured', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - unsupported-branch\n');

    await probot.receive({
      id: 'evt-ub-no-branches',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when unsupported-branch is not enabled', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-ub-disabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});
