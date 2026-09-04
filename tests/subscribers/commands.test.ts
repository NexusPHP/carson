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
const NUMBER = 42;
const COMMENT_ID = 555;
const API = 'https://api.github.com';
const ISSUE = `/repos/acme/widgets/issues/${NUMBER}`;

const mockInstallationToken = (): void => {
  nock(API)
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' });
};

interface SettingsOverrides {
  commands?: string[];
  roles?: string[];
  allowed_labels?: string[];
  react?: boolean;
}

// JSON is valid YAML, so configs are served as JSON strings.
const configFor = (
  settings: SettingsOverrides | null = {},
  subscribers: string[] = ['commands', 'auto-labeler'],
): string =>
  JSON.stringify({
    version: 1,
    subscribers,
    ...(settings === null ? {} : { settings: { commands: settings } }),
  });

const mockConfig = (yaml: string | null): void => {
  const scope = nock(API);

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

const mockRole = (roleName: string | null, login = 'alice'): nock.Scope =>
  roleName === null
    ? nock(API).get(`/repos/acme/widgets/collaborators/${login}/permission`).reply(404)
    : nock(API).get(`/repos/acme/widgets/collaborators/${login}/permission`).reply(200, { permission: 'write', role_name: roleName });

const mockReaction = (): nock.Scope =>
  nock(API)
    .post(`/repos/acme/widgets/issues/comments/${COMMENT_ID}/reactions`, (body: { content: string }) => {
      expect(body.content).toBe('+1');
      return true;
    })
    .reply(201, {});

const mockAddLabels = (labels: string[]): nock.Scope =>
  nock(API)
    .post(`${ISSUE}/labels`, (body: { labels: string[] }) => {
      expect(body.labels).toEqual(labels);
      return true;
    })
    .reply(200, []);

const mockRemoveLabel = (name: string, status = 200): nock.Scope =>
  nock(API).delete(`${ISSUE}/labels/${encodeURIComponent(name)}`).reply(status, []);

const mockUpdate = (expected: Record<string, unknown>, times = 1): nock.Scope =>
  nock(API)
    .patch(ISSUE, (body: Record<string, unknown>) => {
      expect(body).toEqual(expected);
      return true;
    })
    .times(times)
    .reply(200, {});

const mockAssignees = (kind: 'add' | 'remove', assignees: string[]): nock.Scope => {
  const check = (body: { assignees: string[] }): boolean => {
    expect(body.assignees).toEqual(assignees);
    return true;
  };

  return kind === 'add'
    ? nock(API).post(`${ISSUE}/assignees`, check).reply(201, {})
    : nock(API).delete(`${ISSUE}/assignees`, check).reply(200, {});
};

const mockLock = (): nock.Scope => nock(API).put(`${ISSUE}/lock`).reply(204);

interface PayloadOverrides {
  user?: { login: string } | null;
  senderType?: string;
  pullRequest?: boolean;
}

const commentPayload = (body: string, overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: 'created',
  installation: { id: INSTALLATION_ID },
  comment: {
    id: COMMENT_ID,
    body,
    user: overrides.user === undefined ? { login: 'alice' } : overrides.user,
    author_association: 'CONTRIBUTOR',
  },
  issue: {
    number: NUMBER,
    title: 'Something',
    user: { login: 'octocat' },
    labels: [],
    ...(overrides.pullRequest === true ? { pull_request: { url: 'https://example/pr' } } : {}),
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
});

const receive = async (probot: Probot, body: string, overrides: PayloadOverrides = {}): Promise<void> => {
  await probot.receive({
    id: 'evt-command',
    name: 'issue_comment',
    payload: commentPayload(body, overrides) as never,
  });
};

// Authorized commenter with default settings: token + config + role.
const arrange = (settings: SettingsOverrides | null = {}, role = 'write'): void => {
  mockInstallationToken();
  mockConfig(configFor(settings));
  mockRole(role);
};

describe('commands subscriber (via app)', () => {
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

  it('adds labels and reacts for a write-role commenter', async () => {
    arrange(null);
    const labels = mockAddLabels(['bug', 'needs-info']);
    const reaction = mockReaction();

    await receive(probot, 'Looks real.\n/label bug, needs-info\nThanks');

    expect(labels.isDone()).toBe(true);
    expect(reaction.isDone()).toBe(true);
  });

  it('makes no calls at all for a bot sender', async () => {
    await receive(probot, '/close', { senderType: 'Bot' });

    expect(nock.pendingMocks()).toEqual([]);
  });

  // Other subscribers on issue_comment.created load the config, so only the
  // absence of role and mutation calls is asserted here.
  it('never checks the role for a ghost commenter or a comment without commands', async () => {
    mockInstallationToken();
    mockConfig(configFor(null));

    await receive(probot, '/close', { user: null });
    await receive(probot, 'no commands here, just a /path/in/prose');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores commands inside fences, quotes, indentation, inline code, and unknown commands', async () => {
    mockInstallationToken();
    mockConfig(configFor(null));

    await receive(probot, [
      '```',
      '/close',
      '```',
      '~~~',
      '/reopen',
      '~~~',
      '> /close',
      '  /close',
      '`/close`',
      '/deploy now',
    ].join('\n'));

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('checks the role and stops there for a read-role commenter', async () => {
    arrange(null, 'read');

    await receive(probot, '/close');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('treats a non-collaborator (permission lookup 404) as unauthorized', async () => {
    mockInstallationToken();
    mockConfig(configFor(null));
    mockRole(null);

    await receive(probot, '/close');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('honors a custom roles list', async () => {
    arrange({ roles: ['admin'] }, 'write');

    await receive(probot, '/close');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('allows triage-role commenters by default', async () => {
    arrange(null, 'triage');
    const update = mockUpdate({ state: 'closed', state_reason: 'completed' });
    mockReaction();

    await receive(probot, '/close');

    expect(update.isDone()).toBe(true);
  });

  it('closes as not_planned when asked, and without a state reason on pull requests', async () => {
    arrange();
    const notPlanned = mockUpdate({ state: 'closed', state_reason: 'not_planned' });
    mockReaction();

    await receive(probot, '/close not_planned');
    expect(notPlanned.isDone()).toBe(true);

    resetConfigCache();
    nock.cleanAll();
    arrange();
    const pr = mockUpdate({ state: 'closed' });
    mockReaction();

    await receive(probot, '/close', { pullRequest: true });
    expect(pr.isDone()).toBe(true);
  });

  it('reopens', async () => {
    arrange();
    const update = mockUpdate({ state: 'open' });
    mockReaction();

    await receive(probot, '/reopen');

    expect(update.isDone()).toBe(true);
  });

  it('treats /label and /unlabel as failed when auto-labeler is not enabled', async () => {
    mockInstallationToken();
    mockConfig(configFor({}, ['commands']));
    mockRole('write');

    await receive(probot, '/label bug\n/unlabel bug');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('removes labels one by one', async () => {
    arrange();
    const a = mockRemoveLabel('bug');
    const b = mockRemoveLabel('needs info');
    mockReaction();

    await receive(probot, '/unlabel bug, needs info');

    expect(a.isDone()).toBe(true);
    expect(b.isDone()).toBe(true);
  });

  it('does not react when every command failed', async () => {
    arrange();
    mockRemoveLabel('missing', 500);

    await receive(probot, '/unlabel missing\n/unlabel\n/label');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('applies allowed_labels and the label length cap', async () => {
    arrange({ allowed_labels: ['bug', 'docs'] });
    const labels = mockAddLabels(['bug']);
    mockReaction();

    await receive(probot, `/label bug, secret, ${'x'.repeat(51)}`);

    expect(labels.isDone()).toBe(true);
  });

  it('routes /lock to lock-old-issues when it is enabled', async () => {
    mockInstallationToken();
    mockConfig(configFor({}, ['commands', 'lock-old-issues']));
    mockRole('write');
    const lock = mockLock();
    mockReaction();

    await receive(probot, '/lock');

    expect(lock.isDone()).toBe(true);
  });

  it('treats /lock as failed when lock-old-issues is not enabled', async () => {
    arrange();

    await receive(probot, '/lock');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('assigns the commenter by default and named users when given', async () => {
    arrange();
    const self = mockAssignees('add', ['alice']);
    const named = mockAssignees('add', ['bob', 'carol']);
    mockReaction();

    await receive(probot, '/assign\n/assign @bob carol, !!!');

    expect(self.isDone()).toBe(true);
    expect(named.isDone()).toBe(true);
  });

  it('unassigns, and fails assign or unassign with no valid logins', async () => {
    arrange();
    const remove = mockAssignees('remove', ['alice']);
    mockReaction();

    await receive(probot, '/unassign\n/assign !!!\n/unassign !!!');

    expect(remove.isDone()).toBe(true);
  });

  it('skips commands outside the configured commands list', async () => {
    arrange({ commands: ['close'] });

    await receive(probot, '/label bug');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does not react when react is false', async () => {
    arrange({ react: false });
    const update = mockUpdate({ state: 'open' });

    await receive(probot, '/reopen');

    expect(update.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('executes at most ten commands per comment', async () => {
    arrange();
    const update = mockUpdate({ state: 'open' }, 10);
    mockReaction();

    await receive(probot, Array.from({ length: 11 }, () => '/reopen').join('\n'));

    expect(update.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when commands is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig(configFor({}, ['welcome']));

    await receive(probot, '/close');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await receive(probot, '/close');

    expect(nock.pendingMocks()).toEqual([]);
  });
});
