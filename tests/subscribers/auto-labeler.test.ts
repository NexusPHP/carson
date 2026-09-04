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

const mockListFiles = (filenames: string[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/pulls/${PR_NUMBER}/files`)
    .query({ per_page: '100' })
    .reply(200, filenames.map((filename) => ({ filename })));
};

const mockAddLabels = (labels: string[]): nock.Scope => {
  return nock('https://api.github.com')
    .post(`/repos/acme/widgets/issues/${PR_NUMBER}/labels`, (body: { labels: string[] }) => {
      expect([...body.labels].sort()).toEqual([...labels].sort());
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
  action?: 'opened' | 'reopened' | 'synchronize' | 'edited';
  title?: string;
  body?: string | null;
  headRef?: string;
  baseRef?: string;
  labels?: string[];
  senderType?: string;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: false,
    head: { sha: 'abc1234', ref: overrides.headRef ?? 'feature/x' },
    base: { ref: overrides.baseRef ?? 'main' },
    user: { login: 'octocat' },
    title: overrides.title ?? 'Fix the thing',
    body: overrides.body === undefined ? '' : overrides.body,
    labels: (overrides.labels ?? []).map((name) => ({ name })),
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
  ...(overrides.action === 'edited' ? { changes: { title: { from: 'old' } } } : {}),
});

const configWithRules = (rulesYaml: string, syncLabels = false): string => [
  'version: 1',
  'subscribers:',
  '  - auto-labeler',
  'settings:',
  '  auto-labeler:',
  ...(syncLabels ? ['    sync_labels: true'] : []),
  '    rules:',
  rulesYaml,
  '',
].join('\n');

describe('auto-labeler subscriber (via app)', () => {
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

  it('does nothing when auto-labeler is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-not-enabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when no rules are configured', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - auto-labeler\n');

    await probot.receive({
      id: 'evt-no-rules',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does not fetch files when no rule uses files', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: hotfix',
      '        head_branch: ["^hotfix/"]',
    ].join('\n')));
    const addScope = mockAddLabels(['hotfix']);

    await probot.receive({
      id: 'evt-no-files-call',
      name: 'pull_request',
      payload: prPayload({ headRef: 'hotfix/urgent' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('adds a label when any glob in the shorthand list matches a changed file', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: "area:api"',
      '        files: ["src/api/**", "tests/api/**"]',
    ].join('\n')));
    mockListFiles(['src/api/users.ts', 'src/core/util.ts']);
    const addScope = mockAddLabels(['area:api']);

    await probot.receive({
      id: 'evt-files-shorthand',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does not add a label when no changed file matches the globs', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: "area:api"',
      '        files: ["src/api/**"]',
    ].join('\n')));
    mockListFiles(['src/core/util.ts']);

    await probot.receive({
      id: 'evt-files-no-match',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('treats files: { any: [...] } the same as shorthand', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: "area:api"',
      '        files:',
      '          any: ["src/api/**"]',
    ].join('\n')));
    mockListFiles(['src/api/users.ts']);
    const addScope = mockAddLabels(['area:api']);

    await probot.receive({
      id: 'evt-files-any',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('files: { all: [...] } requires every changed file to match a glob', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: docs-only',
      '        files:',
      '          all: ["**/*.md", "docs/**"]',
    ].join('\n')));
    mockListFiles(['README.md', 'docs/guide.md']);
    const addScope = mockAddLabels(['docs-only']);

    await probot.receive({
      id: 'evt-files-all-match',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('files: { all: [...] } skips when one file does not match', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: docs-only',
      '        files:',
      '          all: ["**/*.md"]',
    ].join('\n')));
    mockListFiles(['README.md', 'src/core.ts']);

    await probot.receive({
      id: 'evt-files-all-miss',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('files: with both any and all requires both conditions', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: pure-api',
      '        files:',
      '          any: ["src/api/**"]',
      '          all: ["src/api/**", "tests/api/**"]',
    ].join('\n')));
    mockListFiles(['src/api/users.ts', 'tests/api/users.test.ts']);
    const addScope = mockAddLabels(['pure-api']);

    await probot.receive({
      id: 'evt-files-any-and-all',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('adds a label when the title regex matches', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: type:docs',
      '        title: ["^docs:"]',
    ].join('\n')));
    const addScope = mockAddLabels(['type:docs']);

    await probot.receive({
      id: 'evt-title',
      name: 'pull_request',
      payload: prPayload({ title: 'docs: update README' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('treats a null body as empty when matching', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: needs-discussion',
      '        body: ["NEEDS DISCUSSION"]',
    ].join('\n')));

    await probot.receive({
      id: 'evt-null-body',
      name: 'pull_request',
      payload: prPayload({ body: null }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('adds a label when the body regex matches', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: needs-discussion',
      '        body: ["NEEDS DISCUSSION"]',
    ].join('\n')));
    const addScope = mockAddLabels(['needs-discussion']);

    await probot.receive({
      id: 'evt-body',
      name: 'pull_request',
      payload: prPayload({ body: 'I think this NEEDS DISCUSSION before merge.' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('adds a label when the base_branch regex matches', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: backport',
      '        base_branch: ["^release/"]',
    ].join('\n')));
    const addScope = mockAddLabels(['backport']);

    await probot.receive({
      id: 'evt-base',
      name: 'pull_request',
      payload: prPayload({ baseRef: 'release/1.x' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('matches when any single criterion in a multi-criteria rule matches (OR)', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: type:docs',
      '        files: ["**/*.md"]',
      '        title: ["^docs:"]',
    ].join('\n')));
    mockListFiles(['src/core.ts']);
    const addScope = mockAddLabels(['type:docs']);

    await probot.receive({
      id: 'evt-or',
      name: 'pull_request',
      payload: prPayload({ title: 'docs: update README' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('issues a single addLabels call covering multiple matched rules', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: "area:api"',
      '        files: ["src/api/**"]',
      '      - label: hotfix',
      '        head_branch: ["^hotfix/"]',
    ].join('\n')));
    mockListFiles(['src/api/users.ts']);
    const addScope = mockAddLabels(['area:api', 'hotfix']);

    await probot.receive({
      id: 'evt-multi',
      name: 'pull_request',
      payload: prPayload({ headRef: 'hotfix/urgent' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does not add a label that is already present on the PR', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: hotfix',
      '        head_branch: ["^hotfix/"]',
    ].join('\n')));

    await probot.receive({
      id: 'evt-already',
      name: 'pull_request',
      payload: prPayload({ headRef: 'hotfix/urgent', labels: ['hotfix'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('treats an empty files shorthand array as no matcher', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: "area:api"',
      '        files: []',
    ].join('\n')));
    mockListFiles(['src/api/users.ts']);

    await probot.receive({
      id: 'evt-empty-shorthand',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('treats files: { all: [] } as no matcher', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: docs-only',
      '        files:',
      '          all: []',
    ].join('\n')));
    mockListFiles(['README.md']);

    await probot.receive({
      id: 'evt-empty-all',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('treats files: {} (no any or all) as no matcher', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: docs-only',
      '        files: {}',
    ].join('\n')));
    mockListFiles(['README.md']);

    await probot.receive({
      id: 'evt-empty-object',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips an invalid regex but still evaluates the others', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: type:docs',
      '        title: ["[unclosed", "^docs:"]',
    ].join('\n')));
    const addScope = mockAddLabels(['type:docs']);

    await probot.receive({
      id: 'evt-bad-regex',
      name: 'pull_request',
      payload: prPayload({ title: 'docs: update README' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does not remove labels when sync_labels is off (default)', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: hotfix',
      '        head_branch: ["^hotfix/"]',
    ].join('\n')));

    await probot.receive({
      id: 'evt-no-sync',
      name: 'pull_request',
      payload: prPayload({ headRef: 'main', labels: ['hotfix'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('removes a managed label that no longer matches when sync_labels is on', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: hotfix',
      '        head_branch: ["^hotfix/"]',
    ].join('\n'), true));
    const removeScope = mockRemoveLabel('hotfix');

    await probot.receive({
      id: 'evt-sync-remove',
      name: 'pull_request',
      payload: prPayload({ headRef: 'main', labels: ['hotfix'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
  });

  it('does not remove non-managed labels under sync_labels', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: hotfix',
      '        head_branch: ["^hotfix/"]',
    ].join('\n'), true));

    await probot.receive({
      id: 'evt-sync-non-managed',
      name: 'pull_request',
      payload: prPayload({ headRef: 'main', labels: ['bug', 'area:api'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('fires on pull_request.synchronize', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - label: hotfix',
      '        head_branch: ["^hotfix/"]',
    ].join('\n')));
    const addScope = mockAddLabels(['hotfix']);

    await probot.receive({
      id: 'evt-sync',
      name: 'pull_request',
      payload: prPayload({ action: 'synchronize', headRef: 'hotfix/urgent' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does nothing when the sender is a bot', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({
      id: 'evt-bot',
      name: 'pull_request',
      payload: prPayload({ senderType: 'Bot' }) as never,
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
