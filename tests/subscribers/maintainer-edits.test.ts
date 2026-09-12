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
const MARKER = '<!-- carson:maintainer-edits -->';

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

const mockListComments = (comments: { body: string; userType?: string }[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`)
    .query({ per_page: '100' })
    .reply(200, comments.map((c, i) => ({
      id: 100 + i,
      node_id: `IC_${i}`,
      body: c.body,
      user: { login: c.userType === 'Bot' ? 'carson[bot]' : 'someone', type: c.userType ?? 'User' },
    })));
};

const mockCreateComment = (verify: (body: string) => boolean): nock.Scope => {
  return nock('https://api.github.com')
    .post(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`, (body: { body: string }) => verify(body.body))
    .reply(201, { id: 999 });
};

interface PayloadOverrides {
  action?: 'opened' | 'ready_for_review';
  draft?: boolean;
  maintainerCanModify?: boolean;
  headRepo?: string | null;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: overrides.draft ?? false,
    maintainer_can_modify: overrides.maintainerCanModify ?? false,
    head: {
      sha: 'abc1234',
      ref: 'feature/widget',
      repo: overrides.headRepo === null ? null : { full_name: overrides.headRepo ?? 'octocat/widgets' },
    },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: [],
  },
  repository: { owner: { login: 'acme' }, name: 'widgets', full_name: 'acme/widgets', default_branch: 'main' },
  sender: { type: 'User' },
});

const CONFIG_ENABLED = 'version: 1\nsubscribers:\n  - maintainer-edits\n';

describe('maintainer-edits subscriber (via app)', () => {
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

  it('comments on a fork PR that disallows maintainer edits', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListComments([]);
    const createScope = mockCreateComment((body) => {
      expect(body).toContain('Hey @octocat');
      expect(body).toContain('allow edits from maintainers');
      expect(body.endsWith(MARKER)).toBe(true);
      return true;
    });

    await probot.receive({
      id: 'evt-me-post',
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
      '  - maintainer-edits',
      'settings:',
      '  maintainer-edits:',
      '    message: "{{user}} on {{repo}}#{{number}}"',
      '',
    ].join('\n'));
    mockListComments([]);
    const createScope = mockCreateComment((body) => {
      expect(body).toContain('octocat on widgets#42');
      return true;
    });

    await probot.receive({
      id: 'evt-me-custom',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('does nothing when maintainer edits are allowed', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);

    await probot.receive({
      id: 'evt-me-allowed',
      name: 'pull_request',
      payload: prPayload({ maintainerCanModify: true }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing for a same-repository branch', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);

    await probot.receive({
      id: 'evt-me-same-repo',
      name: 'pull_request',
      payload: prPayload({ headRepo: 'acme/widgets' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips draft PRs until ready_for_review', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);

    await probot.receive({
      id: 'evt-me-draft',
      name: 'pull_request',
      payload: prPayload({ draft: true }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);

    mockListComments([]);
    const createScope = mockCreateComment(() => true);

    await probot.receive({
      id: 'evt-me-ready',
      name: 'pull_request',
      payload: prPayload({ action: 'ready_for_review' }) as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('does not post a second notice when one already exists', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListComments([{ body: `earlier\n\n${MARKER}`, userType: 'Bot' }]);

    await probot.receive({
      id: 'evt-me-dupe',
      name: 'pull_request',
      payload: prPayload({ action: 'ready_for_review' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores a forged marker from a non-bot comment', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListComments([{ body: `forged\n\n${MARKER}` }]);
    const createScope = mockCreateComment(() => true);

    await probot.receive({
      id: 'evt-me-forged',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('does nothing when maintainer-edits is not enabled', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-me-disabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});
