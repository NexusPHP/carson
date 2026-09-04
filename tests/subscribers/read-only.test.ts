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

interface SettingsOverrides {
  upstream?: string;
  message?: string;
  lock?: boolean;
  issues?: boolean;
  pull_requests?: boolean;
}

// JSON is valid YAML, so configs are served as JSON strings.
const configFor = (
  settings: SettingsOverrides | null = {},
  subscribers: string[] = ['read-only', 'lock-old-issues'],
): string =>
  JSON.stringify({
    version: 1,
    subscribers,
    ...(settings === null ? {} : { settings: { 'read-only': settings } }),
  });

const mockConfig = (yaml: string | null): void => {
  const scope = nock('https://api.github.com');

  if (yaml === null) {
    scope
      .get('/repos/acme/mirror/contents/.github%2Fcarson.yml').reply(404)
      .get('/repos/acme/.github/contents/.github%2Fcarson.yml').reply(404);

    return;
  }

  scope
    .get('/repos/acme/mirror/contents/.github%2Fcarson.yml')
    .reply(200, yaml);
};

interface ItemOverrides {
  user?: { login: string } | null;
  senderType?: string;
}

const openedPayload = (kind: 'issue' | 'pull_request', overrides: ItemOverrides = {}): Record<string, unknown> => ({
  action: 'opened',
  installation: { id: INSTALLATION_ID },
  [kind]: {
    number: 42,
    title: 'Something',
    user: overrides.user === undefined ? { login: 'octocat' } : overrides.user,
  },
  repository: {
    owner: { login: 'acme' },
    name: 'mirror',
  },
  sender: { type: overrides.senderType ?? 'User' },
});

const receive = async (probot: Probot, kind: 'issue' | 'pull_request', overrides: ItemOverrides = {}): Promise<void> => {
  await probot.receive({
    id: 'evt-read-only',
    name: kind === 'issue' ? 'issues' : 'pull_request',
    payload: openedPayload(kind, overrides) as never,
  });
};

const mockComment = (expected?: string): nock.Scope =>
  nock('https://api.github.com')
    .post('/repos/acme/mirror/issues/42/comments', (body: { body: string }) => {
      if (expected !== undefined) {
        expect(body.body).toBe(expected);
      }
      return true;
    })
    .reply(201, {});

const mockClose = (expectedReason: string | undefined): nock.Scope =>
  nock('https://api.github.com')
    .patch('/repos/acme/mirror/issues/42', (body: { state: string; state_reason?: string }) => {
      expect(body.state).toBe('closed');
      expect(body.state_reason).toBe(expectedReason);
      return true;
    })
    .reply(200, {});

const mockLock = (): nock.Scope =>
  nock('https://api.github.com')
    .put('/repos/acme/mirror/issues/42/lock', (body: { lock_reason: string }) => {
      expect(body.lock_reason).toBe('resolved');
      return true;
    })
    .reply(204);

describe('read-only subscriber (via app)', () => {
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

  it('comments, closes as not_planned, and locks an opened issue with default settings', async () => {
    mockInstallationToken();
    mockConfig(configFor(null));
    const comment = mockComment('This repository is read-only, so this issue has been closed.');
    const close = mockClose('not_planned');
    const lock = mockLock();

    await receive(probot, 'issue');

    expect(comment.isDone()).toBe(true);
    expect(close.isDone()).toBe(true);
    expect(lock.isDone()).toBe(true);
  });

  it('comments, closes without a state reason, and locks an opened pull request', async () => {
    mockInstallationToken();
    mockConfig(configFor());
    const comment = mockComment('This repository is read-only, so this pull request has been closed.');
    const close = mockClose(undefined);
    const lock = mockLock();

    await receive(probot, 'pull_request');

    expect(comment.isDone()).toBe(true);
    expect(close.isDone()).toBe(true);
    expect(lock.isDone()).toBe(true);
  });

  it('interpolates {{user}}, {{upstream}} as a repo link, and {{upstream_url}} into a custom message', async () => {
    mockInstallationToken();
    mockConfig(configFor({
      upstream: 'acme/main',
      message: '@{{user}}, {{repo}}#{{number}} is a mirror. Open this {{type}} on {{upstream}} ({{upstream_url}}).',
    }));
    const comment = mockComment('@octocat, mirror#42 is a mirror. Open this issue on [acme/main](https://github.com/acme/main) (https://github.com/acme/main).');
    mockClose('not_planned');
    mockLock();

    await receive(probot, 'issue');

    expect(comment.isDone()).toBe(true);
  });

  it('falls back to defaults when upstream is not owner/repo', async () => {
    mockInstallationToken();
    mockConfig(configFor({ upstream: 'https://github.com/acme/main', message: 'custom' }));
    const comment = mockComment('This repository is read-only, so this issue has been closed.');
    mockClose('not_planned');
    mockLock();

    await receive(probot, 'issue');

    expect(comment.isDone()).toBe(true);
  });

  it('leaves {{user}} verbatim when the item has no user (ghost)', async () => {
    mockInstallationToken();
    mockConfig(configFor({ message: 'Hi {{user}}' }));
    const comment = mockComment('Hi {{user}}');
    mockClose('not_planned');
    mockLock();

    await receive(probot, 'issue', { user: null });

    expect(comment.isDone()).toBe(true);
  });

  it('still closes and locks when the sender is a bot', async () => {
    mockInstallationToken();
    mockConfig(configFor());
    mockComment();
    const close = mockClose(undefined);
    const lock = mockLock();

    await receive(probot, 'pull_request', { senderType: 'Bot' });

    expect(close.isDone()).toBe(true);
    expect(lock.isDone()).toBe(true);
  });

  it('does not lock when lock is false', async () => {
    mockInstallationToken();
    mockConfig(configFor({ lock: false }));
    mockComment();
    const close = mockClose('not_planned');

    await receive(probot, 'issue');

    expect(close.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('closes but cannot lock when lock-old-issues is not enabled', async () => {
    mockInstallationToken();
    mockConfig(configFor({}, ['read-only']));
    mockComment();
    const close = mockClose('not_planned');

    await receive(probot, 'issue');

    expect(close.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores issues when issues is false', async () => {
    mockInstallationToken();
    mockConfig(configFor({ issues: false }));

    await receive(probot, 'issue');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores pull requests when pull_requests is false', async () => {
    mockInstallationToken();
    mockConfig(configFor({ pull_requests: false }));

    await receive(probot, 'pull_request');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when read-only is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig(configFor({}, ['lock-old-issues']));

    await receive(probot, 'issue');
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await receive(probot, 'issue');
  });
});
