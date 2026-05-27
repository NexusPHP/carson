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

const enabledOnlyYaml = 'version: 1\nsubscribers:\n  - welcome\n';

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

  it('greets a first-time PR contributor with the default first_time message', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Thanks for opening your first pull request, @octocat!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-ft-pr-default',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('greets a first-time issue opener with the default first_time message', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/7/comments', (body: { body: string }) => {
        expect(body.body).toBe('Thanks for opening your first issue, @octocat!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-ft-issue-default',
      name: 'issues',
      payload: issuesOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('also greets FIRST_TIMER with the default first_time message', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments').reply(201, {});

    await probot.receive({
      id: 'evt-first-timer-default',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'FIRST_TIMER' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('greets a returning PR contributor with the default returning message', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Thanks for the pull request, @octocat!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-ret-pr-default',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'CONTRIBUTOR' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('greets a returning issue opener with the default returning message', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/7/comments', (body: { body: string }) => {
        expect(body.body).toBe('Thanks for filing this, @octocat!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-ret-issue-default',
      name: 'issues',
      payload: issuesOpenedPayload({ association: 'MEMBER' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('uses a custom first_time.pull_request message when configured', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    first_time:',
      '      pull_request: "Hi @{{user}}, first PR!"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Hi @octocat, first PR!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-ft-pr-custom',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('uses a custom first_time.issue message when configured', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    first_time:',
      '      issue: "Hi @{{user}}, first issue!"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/7/comments', (body: { body: string }) => {
        expect(body.body).toBe('Hi @octocat, first issue!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-ft-issue-custom',
      name: 'issues',
      payload: issuesOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('uses a custom returning.pull_request message when configured', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    returning:',
      '      pull_request: "Welcome back, @{{user}}!"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        expect(body.body).toBe('Welcome back, @octocat!');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-ret-pr-custom',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'CONTRIBUTOR' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('uses a custom returning.issue message when configured', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    returning:',
      '      issue: "Thanks @{{user}}, we will take a look."',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/7/comments', (body: { body: string }) => {
        expect(body.body).toBe('Thanks @octocat, we will take a look.');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-ret-issue-custom',
      name: 'issues',
      payload: issuesOpenedPayload({ association: 'COLLABORATOR' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('narrows the first_time bucket via author_association to a subset', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    first_time:',
      '      author_association: [FIRST_TIME_CONTRIBUTOR]',
      '',
    ].join('\n'));

    // FIRST_TIMER is excluded from the narrowed first_time list, and
    // first-timer associations are not allowed in the returning bucket, so
    // no comment fires for FIRST_TIMER.
    await probot.receive({
      id: 'evt-ft-narrowed-excludes',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'FIRST_TIMER' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('narrows the returning bucket via author_association to a subset', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    returning:',
      '      author_association: [CONTRIBUTOR]',
      '',
    ].join('\n'));

    // MEMBER is excluded from the narrowed returning list, and returning
    // associations are not allowed in the first_time bucket.
    await probot.receive({
      id: 'evt-ret-narrowed-excludes',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'MEMBER' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('disables the returning bucket entirely via an empty author_association list', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    returning:',
      '      author_association: []',
      '',
    ].join('\n'));

    await probot.receive({
      id: 'evt-ret-disabled',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'CONTRIBUTOR' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('still greets first-timers even when returning bucket is disabled', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    returning:',
      '      author_association: []',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments').reply(201, {});

    await probot.receive({
      id: 'evt-ft-still-fires',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });

  it('does nothing for NONE association on pull_request.opened', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    await probot.receive({
      id: 'evt-none-pr',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'NONE' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing for NONE association on issues.opened', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    await probot.receive({
      id: 'evt-none-issue',
      name: 'issues',
      payload: issuesOpenedPayload({ association: 'NONE' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing for MANNEQUIN association', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    await probot.receive({
      id: 'evt-mannequin',
      name: 'pull_request',
      payload: prOpenedPayload({ association: 'MANNEQUIN' }) as never,
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

  it('does nothing on issues.opened when the issue has no user (ghost)', async () => {
    await probot.receive({
      id: 'evt-ghost',
      name: 'issues',
      payload: issuesOpenedPayload({ user: null }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on pull_request.opened when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({
      id: 'evt-missing-pr',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on issues.opened when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({
      id: 'evt-missing-issue',
      name: 'issues',
      payload: issuesOpenedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when welcome is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - something_else\n');

    await probot.receive({
      id: 'evt-not-enabled',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when carson.yml fails schema validation', async () => {
    mockInstallationToken();
    mockConfig('version: 99\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-invalid-schema',
      name: 'pull_request',
      payload: prOpenedPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('interpolates {{user}}, {{repo}}, {{number}} and {{title}} in a first_time PR message', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    first_time:',
      '      pull_request: "Hi @{{user}}, thanks for PR #{{number}} ({{ title }}) on {{repo}}"',
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

  it('interpolates context keys in a returning issue message', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - welcome',
      'settings:',
      '  welcome:',
      '    returning:',
      '      issue: "@{{user}} opened issue #{{number}}: {{title}}"',
      '',
    ].join('\n'));

    const commentScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/7/comments', (body: { body: string }) => {
        expect(body.body).toBe('@octocat opened issue #7: Something is broken');
        return true;
      })
      .reply(201, {});

    await probot.receive({
      id: 'evt-interp-ret-issue',
      name: 'issues',
      payload: issuesOpenedPayload({ association: 'COLLABORATOR' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
  });
});
