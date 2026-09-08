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
  parents: number;
  subject?: string;
  author?: string | null;
  login?: string | null;
}

const mockListCommits = (commits: CommitInput[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/pulls/${PR_NUMBER}/commits`)
    .query({ per_page: '100' })
    .reply(200, commits.map((c) => ({
      sha: c.sha,
      parents: Array.from({ length: c.parents }, (_, i) => ({ sha: `${i}`.repeat(40) })),
      commit: {
        message: c.subject ?? 'some commit',
        author: c.author === null ? null : { name: c.author ?? 'Octo Cat', email: 'octo@example.com' },
      },
      author: c.login === null ? null : { login: c.login ?? 'octocat' },
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

interface PayloadOverrides {
  action?: string;
  senderType?: string;
  labels?: string[];
  login?: string | null;
  headRef?: string;
  baseRef?: string;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'synchronize',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    head: { sha: HEAD_SHA, ref: overrides.headRef ?? 'feature/widget' },
    base: { ref: overrides.baseRef ?? 'main' },
    user: overrides.login === null ? null : { login: overrides.login ?? 'octocat' },
    title: 'Fix the thing',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
});

const CONFIG_ENABLED = 'version: 1\nsubscribers:\n  - no-merge-commits\n';

const configWith = (settingsYaml: string[]): string => [
  'version: 1',
  'subscribers:',
  '  - no-merge-commits',
  'settings:',
  '  no-merge-commits:',
  ...settingsYaml,
  '',
].join('\n');

const PLAIN = { sha: 'a'.repeat(40), parents: 1 };
const MERGE = { sha: 'b'.repeat(40), parents: 2, subject: 'Merge branch \'main\' into feature/widget', author: 'Merger' };

describe('no-merge-commits subscriber (via app)', () => {
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

  it('posts a success check when no commit has more than one parent', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([PLAIN, { sha: 'c'.repeat(40), parents: 1 }]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.name).toBe('Carson / no-merge-commits');
      expect(body.head_sha).toBe(HEAD_SHA);
      expect(body.status).toBe('completed');
      expect(body.conclusion).toBe('success');
      expect(body.output.title).toBe('No merge commits in 2 commits');
      expect(body.output.text).toBeUndefined();
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-success',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('posts a failure check listing each merge commit', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([PLAIN, MERGE]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('failure');
      expect(body.output.title).toBe('1 merge commit');
      expect(body.output.summary).toContain('1 of 2 commits is a merge commit');
      expect(body.output.text).toContain('bbbbbbb');
      expect(body.output.text).toContain('Merge branch \'main\' into feature/widget');
      expect(body.output.text).toContain('Merger');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-failure',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('pluralizes when several merge commits are found', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([MERGE, { sha: 'd'.repeat(40), parents: 3 }]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.output.title).toBe('2 merge commits');
      expect(body.output.summary).toContain('2 of 2 commits are merge commits');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-plural',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('escapes markdown specials in commit subject and author', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([{ sha: 'e'.repeat(40), parents: 2, subject: '[click](http://evil.example)', author: '<img src=x>' }]);

    const checkScope = mockCreateCheck((body) => {
      const text = body.output.text ?? '';
      expect(text).not.toContain('[click](http://evil.example)');
      expect(text).toContain('\\[click\\]\\(http://evil.example\\)');
      expect(text).toContain('\\<img src=x\\>');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-escape',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('posts a neutral check when treat_merge_commits_as is neutral', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    treat_merge_commits_as: neutral']));
    mockListCommits([MERGE]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('neutral');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-neutral',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('uses a custom check name', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    name: "Linear history"']));
    mockListCommits([PLAIN]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.name).toBe('Linear history');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-name',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('exempts a PR carrying an exempt label without listing commits', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    exempt_labels: [release]']));

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('success');
      expect(body.output.title).toBe('Exempt from the merge-commit check');
      expect(body.output.summary).toBe('This pull request is exempt by label `release`.');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-label',
      name: 'pull_request',
      payload: prPayload({ action: 'labeled', labels: ['bug', 'release'] }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('exempts a PR by author login', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    exempt_authors: ["dependabot[bot]"]']));

    const checkScope = mockCreateCheck((body) => {
      expect(body.output.summary).toBe('This pull request is exempt by author @dependabot[bot].');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-author',
      name: 'pull_request',
      payload: prPayload({ login: 'dependabot[bot]' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('exempts a PR matching a head-only branch rule', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    exempt_branches: [{ head: "^sync/" }]']));

    const checkScope = mockCreateCheck((body) => {
      expect(body.output.summary).toBe('This pull request is exempt by branch rule {"head":"^sync/"}.');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-head',
      name: 'pull_request',
      payload: prPayload({ headRef: 'sync/upstream' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('exempts a PR only when both head and base of a branch rule match', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    exempt_branches: [{ head: "^develop$", base: "^master$" }]']));

    const checkScope = mockCreateCheck((body) => {
      expect(body.output.summary).toBe('This pull request is exempt by branch rule {"head":"^develop$","base":"^master$"}.');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-both',
      name: 'pull_request',
      payload: prPayload({ headRef: 'develop', baseRef: 'master' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('checks the commits when only one side of a branch rule matches', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    exempt_branches: [{ head: "^develop$", base: "^master$" }]']));
    mockListCommits([MERGE]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('failure');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-one-side',
      name: 'pull_request',
      payload: prPayload({ headRef: 'feature/x', baseRef: 'master' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('ignores an empty branch rule', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    exempt_branches: [{}]']));
    mockListCommits([PLAIN]);
    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('success');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-empty-rule',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('skips an invalid exemption pattern and still checks the commits', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    exempt_branches: [{ head: "(" }]']));
    mockListCommits([MERGE]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('failure');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-bad-regex',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('checks the commits when no exemption applies', async () => {
    mockInstallationToken();
    mockConfig(configWith([
      '    exempt_labels: [release]',
      '    exempt_authors: [octobot]',
      '    exempt_branches: [{ head: "^sync/" }, { base: "^release/" }]',
    ]));
    mockListCommits([PLAIN]);
    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('success');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-no-exemption',
      name: 'pull_request',
      payload: prPayload({ labels: ['bug'] }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('checks the commits of a ghost-authored PR', async () => {
    mockInstallationToken();
    mockConfig(configWith(['    exempt_authors: [octocat]']));
    mockListCommits([PLAIN]);
    const checkScope = mockCreateCheck(() => true);

    await probot.receive({
      id: 'evt-nmc-ghost',
      name: 'pull_request',
      payload: prPayload({ login: null }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('falls back to the author login, then "unknown", when the commit author name is missing', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([
      { sha: 'f'.repeat(40), parents: 2, author: null, login: 'fallback-user' },
      { sha: '9'.repeat(40), parents: 2, author: null, login: null },
    ]);

    const checkScope = mockCreateCheck((body) => {
      expect(body.output.text).toContain('fallback-user');
      expect(body.output.text).toContain('unknown');
      return true;
    });

    await probot.receive({
      id: 'evt-nmc-author-fallback',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('checks a PR opened by a bot', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListCommits([PLAIN]);
    const checkScope = mockCreateCheck(() => true);

    await probot.receive({
      id: 'evt-nmc-bot',
      name: 'pull_request',
      payload: prPayload({ action: 'opened', senderType: 'Bot' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('does nothing when no-merge-commits is not enabled', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-nmc-disabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});
