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
  association?: string;
  senderType?: string;
  user?: { login: string } | null;
  title?: string;
}

const prOpenedPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: overrides.number ?? 42,
    author_association: overrides.association ?? 'FIRST_TIME_CONTRIBUTOR',
    user: overrides.user === undefined ? { login: 'octocat' } : overrides.user,
    title: overrides.title ?? 'Fix the thing',
  },
  repository: {
    owner: { login: 'acme' },
    name: 'widgets',
  },
  sender: { type: overrides.senderType ?? 'User' },
});

const issuesOpenedPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: 'opened',
  installation: { id: INSTALLATION_ID },
  issue: {
    number: overrides.number ?? 7,
    author_association: overrides.association ?? 'FIRST_TIME_CONTRIBUTOR',
    user: overrides.user === undefined ? { login: 'octocat' } : overrides.user,
    title: overrides.title ?? 'Something is broken',
  },
  repository: {
    owner: { login: 'acme' },
    name: 'widgets',
  },
  sender: { type: overrides.senderType ?? 'User' },
});

describe('welcome subscriber (via app)', () => {
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

  it('comments on pull_request.opened with the default message', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Thanks for opening your first pull request, @octocat!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-1',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('comments on issues.opened with the default message', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/7/comments', (body: { body: string }) => {
        expect(body.body).toBe('Thanks for opening your first issue, @octocat!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-2',
      name: 'issues',
      payload: issuesOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('also greets a FIRST_TIMER (never contributed anywhere on GitHub)', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments').reply(201, {});

    await probot.receive({
      id: 'evt-first-timer',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'FIRST_TIMER' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('does nothing on pull_request.opened when the author is not a first-time contributor', async () => {
    await probot.receive({
      id: 'evt-non-first',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'CONTRIBUTOR' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on issues.opened when the author is not a first-time contributor', async () => {
    await probot.receive({
      id: 'evt-non-first-issue',
      name: 'issues',
      payload: issuesOpenedPayload({ association: 'MEMBER' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on pull_request.opened when the sender is a bot', async () => {
    await probot.receive({
      id: 'evt-bot-pr',
      name: 'pull_request',
      payload: prOpenedPayload({ senderType: 'Bot' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on issues.opened when the sender is a bot', async () => {
    await probot.receive({
      id: 'evt-bot-issue',
      name: 'issues',
      payload: issuesOpenedPayload({ senderType: 'Bot' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('uses configured pull_request message when settings.welcome.pull_request is set', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    pull_request: "Hello from carson.yml!"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Hello from carson.yml!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-3',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('uses configured issue message when settings.welcome.issue is set', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    issue: "Hi from carson.yml!"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/7/comments', (body: { body: string }) => {
        expect(body.body).toBe('Hi from carson.yml!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-4',
      name: 'issues',
      payload: issuesOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('does nothing on pull_request.opened when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({
      id: 'evt-5',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on issues.opened when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({
      id: 'evt-5b',
      name: 'issues',
      payload: issuesOpenedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when welcome is not enabled in carson.yml', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - something_else\n');

    await probot.receive({
      id: 'evt-6',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when carson.yml fails schema validation', async () => {
    mockInstallationToken();
    mockConfig('version: 99\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-7',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('interpolates {{user}}, {{repo}}, {{number}} and {{title}} in a custom pull_request message', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    pull_request: "Hi @{{user}}, thanks for PR #{{number}} ({{ title }}) on {{repo}}"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Hi @octocat, thanks for PR #42 (Fix the thing) on widgets');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-interp-pr',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('interpolates variables in a custom issue message', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    issue: "@{{user}} opened issue #{{number}}: {{title}}"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/7/comments', (body: { body: string }) => {
        expect(body.body).toBe('@octocat opened issue #7: Something is broken');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-interp-issue',
      name: 'issues',
      payload: issuesOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('does nothing on issues.opened when the issue has no user (ghost)', async () => {
    await probot.receive({
      id: 'evt-ghost',
      name: 'issues',
      payload: issuesOpenedPayload({ user: null }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});
