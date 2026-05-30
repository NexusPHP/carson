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

interface PayloadOverrides {
  number?: number;
  merged?: boolean;
  user?: { login: string; type?: string } | null;
  mergedBy?: { login: string } | null;
  senderType?: string;
  title?: string;
}

const prClosedPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: 'closed',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: overrides.number ?? 42,
    merged: overrides.merged ?? true,
    user: overrides.user === undefined
      ? { login: 'octocat', type: 'User' }
      : overrides.user === null
        ? null
        : { login: overrides.user.login, type: overrides.user.type ?? 'User' },
    merged_by: overrides.mergedBy === undefined ? { login: 'maintainer' } : overrides.mergedBy,
    title: overrides.title ?? 'Fix the thing',
  },
  repository: {
    owner: { login: 'acme' },
    name: 'widgets',
  },
  sender: { type: overrides.senderType ?? 'User' },
});

const enabledOnlyYaml = 'version: 1\nsubscribers:\n  - thanks\n';

describe('thanks subscriber (via app)', () => {
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

  it('posts the default thanks comment when a maintainer merges a contributor PR', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Thanks for the contribution, @octocat!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-thanks-default',
      name: 'pull_request',
      payload: prClosedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('uses a custom message when configured', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - thanks',
      'settings:',
      '  thanks:',
      '    message: "Cheers @{{user}}, merged!"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Cheers @octocat, merged!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-thanks-custom',
      name: 'pull_request',
      payload: prClosedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('interpolates {{user}}, {{repo}}, {{number}} and {{title}}', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - thanks',
      'settings:',
      '  thanks:',
      '    message: "@{{user}} merged #{{number}} ({{title}}) into {{repo}}"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('@octocat merged #42 (Fix the thing) into widgets');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-thanks-interp',
      name: 'pull_request',
      payload: prClosedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('does nothing when the PR was closed without merging', async () => {
    await probot.receive({
      id: 'evt-thanks-not-merged',
      name: 'pull_request',
      payload: prClosedPayload({ merged: false }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the author merged their own PR', async () => {
    await probot.receive({
      id: 'evt-thanks-self-merge',
      name: 'pull_request',
      payload: prClosedPayload({ mergedBy: { login: 'octocat' } }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the PR author is a bot', async () => {
    await probot.receive({
      id: 'evt-thanks-bot-author',
      name: 'pull_request',
      payload: prClosedPayload({ user: { login: 'dependabot[bot]', type: 'Bot' } }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the PR has no author (ghost)', async () => {
    await probot.receive({
      id: 'evt-thanks-ghost',
      name: 'pull_request',
      payload: prClosedPayload({ user: null }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the sender is a bot', async () => {
    await probot.receive({
      id: 'evt-thanks-bot-sender',
      name: 'pull_request',
      payload: prClosedPayload({ senderType: 'Bot' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when thanks is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-thanks-not-enabled',
      name: 'pull_request',
      payload: prClosedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({
      id: 'evt-thanks-missing',
      name: 'pull_request',
      payload: prClosedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});
