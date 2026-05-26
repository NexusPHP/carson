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
const HEAD_SHA = 'a1b2c3d4e5f6789012345678901234567890abcd';

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

interface CommitInput {
  sha: string;
  verified: boolean;
  subject?: string;
  author?: string;
}

const mockListCommits = (commits: CommitInput[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/pulls/${PR_NUMBER}/commits`)
    .query({ per_page: '100' })
    .reply(200, commits.map((c) => ({
      sha: c.sha,
      commit: {
        message: c.subject ?? 'some commit',
        author: { name: c.author ?? 'Octo Cat', email: 'octo@example.com' },
        verification: { verified: c.verified, reason: c.verified ? 'valid' : 'unsigned' },
      },
      author: { login: c.author ?? 'octocat' },
    })));
};

interface CheckBody {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string;
  output: { title: string; summary: string; text?: string };
}

const mockCreateCheck = (verify: (body: CheckBody) => boolean): nock.Scope => {
  return nock('https://api.github.com')
    .post('/repos/acme/widgets/check-runs', (body: CheckBody) => verify(body))
    .reply(201, { id: 9999 });
};

const prPayload = (overrides: { senderType?: string; action?: string } = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'synchronize',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    head: { sha: HEAD_SHA, ref: 'feature/widget' },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
});

const CONFIG_ENABLED = 'version: 1\nsubscribers:\n  - signed-commits\n';

describe('signed-commits subscriber (via app)', () => {
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

  it('posts a success check when every commit is verified', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([
      { sha: 'aaaaaaa1111111111111111111111111111aaaaa', verified: true },
      { sha: 'bbbbbbb2222222222222222222222222222bbbbb', verified: true },
    ]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.name).toBe('Carson / signed-commits');
      expect(body.head_sha).toBe(HEAD_SHA);
      expect(body.status).toBe('completed');
      expect(body.conclusion).toBe('success');
      expect(body.output.title).toContain('All 2 commit');
      return true;
    });

    await probot.receive({
      id: 'evt-sc-success',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('posts a failure check when any commit is unverified, including the list', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([
      { sha: 'aaaaaaa1111111111111111111111111111aaaaa', verified: true, subject: 'first' },
      { sha: 'bbbbbbb2222222222222222222222222222bbbbb', verified: false, subject: 'second one', author: 'Anonymous' },
    ]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('failure');
      expect(body.output.title).toContain('1 unsigned commit');
      expect(body.output.text).toContain('bbbbbbb');
      expect(body.output.text).toContain('second one');
      expect(body.output.text).toContain('Anonymous');
      return true;
    });

    await probot.receive({
      id: 'evt-sc-failure',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('escapes markdown specials in commit subject and author (injection defense)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([
      {
        sha: 'eeeeeee3333333333333333333333333333eeeee',
        verified: false,
        subject: '[click](http://evil.example)',
        author: '<img src=x>',
      },
    ]);

    const checkScope = mockCreateCheck((body) => {
      const text = body.output.text ?? '';
      expect(text).not.toContain('[click](http://evil.example)');
      expect(text).not.toContain('<img src=x>');
      expect(text).toContain('\\[click\\]\\(http://evil.example\\)');
      expect(text).toContain('\\<img src=x\\>');
      return true;
    });

    await probot.receive({
      id: 'evt-sc-escape',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('posts a neutral check when treat_unsigned_as is neutral', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - signed-commits',
      'settings:',
      '  signed-commits:',
      '    treat_unsigned_as: neutral',
      '',
    ].join('\n'));
    mockListCommits([
      { sha: 'cccccccccccccccccccccccccccccccccccccccc', verified: false },
    ]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('neutral');
      return true;
    });

    await probot.receive({
      id: 'evt-sc-neutral',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('uses a custom name when settings.signed-commits.name is set', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - signed-commits',
      'settings:',
      '  signed-commits:',
      '    name: "Signed commits"',
      '',
    ].join('\n'));
    mockListCommits([{ sha: 'd'.repeat(40), verified: true }]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.name).toBe('Signed commits');
      return true;
    });

    await probot.receive({
      id: 'evt-sc-custom-name',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('does nothing when signed-commits is not enabled', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-sc-disabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the sender is a bot', async () => {
    await probot.receive({
      id: 'evt-sc-bot',
      name: 'pull_request',
      payload: prPayload({ senderType: 'Bot' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('fires on pull_request.opened', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([{ sha: 'e'.repeat(40), verified: true }]);
    const checkScope = mockCreateCheck(() => true);

    await probot.receive({
      id: 'evt-sc-opened',
      name: 'pull_request',
      payload: prPayload({ action: 'opened' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('falls back to author login when commit author name is missing', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    nock('https://api.github.com')
      .get(`/repos/acme/widgets/pulls/${PR_NUMBER}/commits`)
      .query({ per_page: '100' })
      .reply(200, [{
        sha: 'f'.repeat(40),
        commit: {
          message: 'commit without author name',
          author: null,
          verification: { verified: false, reason: 'unsigned' },
        },
        author: { login: 'fallback-user' },
      }]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.output.text).toContain('fallback-user');
      return true;
    });

    await probot.receive({
      id: 'evt-sc-author-fallback',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('uses "unknown" when both commit author and author login are missing', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    nock('https://api.github.com')
      .get(`/repos/acme/widgets/pulls/${PR_NUMBER}/commits`)
      .query({ per_page: '100' })
      .reply(200, [{
        sha: '9'.repeat(40),
        commit: {
          message: 'ghost commit',
          author: null,
          verification: { verified: false, reason: 'unsigned' },
        },
        author: null,
      }]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.output.text).toContain('unknown');
      return true;
    });

    await probot.receive({
      id: 'evt-sc-unknown-author',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });
});
