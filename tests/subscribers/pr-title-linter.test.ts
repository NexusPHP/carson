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
  action?: 'opened' | 'edited';
  title?: string;
  senderType?: string;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    head: { sha: HEAD_SHA, ref: 'feature/widget' },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: overrides.title ?? 'feat: add widget',
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
  // pull_request.edited requires a `changes` field per the webhook schema.
  changes: { title: { from: 'previous title' } },
});

const configWithRules = (rulesYaml: string, nameOverride?: string): string => [
  'version: 1',
  'subscribers:',
  '  - pr-title-linter',
  'settings:',
  '  pr-title-linter:',
  ...(nameOverride !== undefined ? [`    name: "${nameOverride}"`] : []),
  '    rules:',
  rulesYaml,
  '',
].join('\n');

const CONVENTIONAL_RULE = [
  '      - pattern: "^(feat|fix|docs|chore|refactor|test)(\\\\(.+\\\\))?: .+"',
  '        description: "Follow conventional commits"',
].join('\n');

const NO_WIP_RULE = [
  '      - pattern: "^(WIP|TODO|DRAFT)\\\\b"',
  '        description: "Avoid WIP/TODO/DRAFT prefixes"',
  '        mode: forbid',
  '        level: warning',
].join('\n');

describe('pr-title-linter subscriber (via app)', () => {
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

  it('does nothing when pr-title-linter is not listed in subscribers', async () => {
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
    mockConfig('version: 1\nsubscribers:\n  - pr-title-linter\n');

    await probot.receive({
      id: 'evt-no-rules',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
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

  it('posts a success check when every rule matches', async () => {
    mockInstallationToken();
    mockConfig(configWithRules(CONVENTIONAL_RULE));

    const checkScope = mockCreateCheck((body) => {
      expect(body.name).toBe('Carson / pr-title-linter');
      expect(body.head_sha).toBe(HEAD_SHA);
      expect(body.conclusion).toBe('success');
      expect(body.output.title).toBe('Title passes all 1 rule(s)');
      expect(body.output.text).toBeUndefined();
      return true;
    });

    await probot.receive({
      id: 'evt-success',
      name: 'pull_request',
      payload: prPayload({ title: 'feat: add widget' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('posts a failure check when a require rule fails (default error level)', async () => {
    mockInstallationToken();
    mockConfig(configWithRules(CONVENTIONAL_RULE));

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('failure');
      expect(body.output.title).toBe('1 of 1 rule(s) failed');
      expect(body.output.text).toContain('error');
      expect(body.output.text).toContain('Follow conventional commits');
      return true;
    });

    await probot.receive({
      id: 'evt-require-fail',
      name: 'pull_request',
      payload: prPayload({ title: 'just some random title' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('posts a failure check when a forbid rule matches with error level', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - pattern: "^WIP"',
      '        description: "No WIP titles"',
      '        mode: forbid',
    ].join('\n')));

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('failure');
      expect(body.output.text).toContain('forbid');
      expect(body.output.text).toContain('No WIP titles');
      return true;
    });

    await probot.receive({
      id: 'evt-forbid-fail',
      name: 'pull_request',
      payload: prPayload({ title: 'WIP: still working' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('posts a neutral check when only warning-level rules fail', async () => {
    mockInstallationToken();
    mockConfig(configWithRules(NO_WIP_RULE));

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('neutral');
      expect(body.output.text).toContain('warning');
      return true;
    });

    await probot.receive({
      id: 'evt-warning-only',
      name: 'pull_request',
      payload: prPayload({ title: 'WIP: still working' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('posts a failure check when an error rule fails alongside warning rules', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([CONVENTIONAL_RULE, NO_WIP_RULE].join('\n')));

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('failure');
      expect(body.output.title).toBe('2 of 2 rule(s) failed');
      expect(body.output.text).toContain('error');
      expect(body.output.text).toContain('warning');
      return true;
    });

    await probot.receive({
      id: 'evt-mixed',
      name: 'pull_request',
      payload: prPayload({ title: 'WIP: still working' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('skips a rule with an invalid regex but still evaluates the others', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - pattern: "[unclosed"',
      '        description: "Broken rule"',
      CONVENTIONAL_RULE,
    ].join('\n')));

    const checkScope = mockCreateCheck((body) => {
      expect(body.output.title).toBe('Title passes all 1 rule(s)');
      expect(body.conclusion).toBe('success');
      return true;
    });

    await probot.receive({
      id: 'evt-bad-regex',
      name: 'pull_request',
      payload: prPayload({ title: 'feat: add widget' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('does nothing when every configured rule has an invalid regex', async () => {
    mockInstallationToken();
    mockConfig(configWithRules([
      '      - pattern: "[unclosed"',
      '        description: "Broken rule"',
    ].join('\n')));

    await probot.receive({
      id: 'evt-all-bad',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('uses a custom check name when configured', async () => {
    mockInstallationToken();
    mockConfig(configWithRules(CONVENTIONAL_RULE, 'PR Title'));

    const checkScope = mockCreateCheck((body) => {
      expect(body.name).toBe('PR Title');
      return true;
    });

    await probot.receive({
      id: 'evt-custom-name',
      name: 'pull_request',
      payload: prPayload({ title: 'feat: add widget' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
  });

  it('also runs on pull_request.edited', async () => {
    mockInstallationToken();
    mockConfig(configWithRules(CONVENTIONAL_RULE));

    const checkScope = mockCreateCheck((body) => {
      expect(body.conclusion).toBe('failure');
      return true;
    });

    await probot.receive({
      id: 'evt-edited',
      name: 'pull_request',
      payload: prPayload({ action: 'edited', title: 'random' }) as never,
    });

    expect(checkScope.isDone()).toBe(true);
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
