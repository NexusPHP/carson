import * as core from '@actions/core';
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

const API = 'https://api.github.com';
const INSTALLATION_ID = 12345;
const PR_NUMBER = 42;
const ISSUE_NUMBER = 7;
const MARKER = '<!-- carson:welcome -->';

const mockInstallationToken = (): void => {
  nock(API)
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' });
};

const mockConfig = (yaml: string | null): void => {
  const scope = nock(API);

  if (yaml === null) {
    scope
      .get('/repos/acme/widgets/contents/.github%2Fcarson.yml').reply(404)
      .get('/repos/acme/.github/contents/.github%2Fcarson.yml').reply(404);

    return;
  }

  scope.get('/repos/acme/widgets/contents/.github%2Fcarson.yml').reply(200, yaml);
};

const mockEarlierItems = (type: 'pr' | 'issue', total: number, status = 200): nock.Scope =>
  nock(API)
    .get('/search/issues')
    .query((query) =>
      query['q'] === `repo:acme/widgets is:${type} author:octocat created:<2026-09-19T08:00:00Z`
      && query['per_page'] === '1',
    )
    .reply(status, { total_count: total, incomplete_results: false, items: [] });

const mockPermission = (roleName: string): nock.Scope =>
  nock(API)
    .get('/repos/acme/widgets/collaborators/octocat/permission')
    .reply(200, { permission: 'write', role_name: roleName });

const mockComment = (number: number, expected: string): nock.Scope =>
  nock(API)
    .post(`/repos/acme/widgets/issues/${number}/comments`, (body: { body: string }) => {
      expect(body.body).toBe(`${expected}\n\n${MARKER}`);

      return true;
    })
    .reply(201, {});

interface PayloadOverrides {
  action?: 'opened' | 'ready_for_review';
  draft?: boolean;
  senderType?: string;
  user?: { login: string } | null;
  title?: string;
}

const opened = (overrides: PayloadOverrides, number: number, title: string): Record<string, unknown> => ({
  number,
  draft: overrides.draft ?? false,
  user: overrides.user === undefined ? { login: 'octocat' } : overrides.user,
  title: overrides.title ?? title,
  created_at: '2026-09-19T08:00:00Z',
  labels: [],
});

const mockComments = (bodies: string[]): nock.Scope =>
  nock(API)
    .get(`/repos/acme/widgets/issues/${PR_NUMBER}/comments`)
    .query({ per_page: '100' })
    .reply(200, bodies.map((body, i) => ({ id: 9000 + i, body, user: { login: 'carson[bot]', type: 'Bot' } })));

const prOpenedPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: opened(overrides, PR_NUMBER, 'Fix the thing'),
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
});

const issuesOpenedPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: 'opened',
  installation: { id: INSTALLATION_ID },
  issue: opened(overrides, ISSUE_NUMBER, 'Something is broken'),
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
});

const enabledOnlyYaml = 'version: 1\nsubscribers:\n  - welcome\n';

const withSettings = (lines: string[]): string => [
  'version: 1',
  'subscribers:',
  '  - welcome',
  'settings:',
  '  welcome:',
  ...lines.map((line) => `    ${line}`),
  '',
].join('\n');

describe('welcome subscriber (via app)', () => {
  let probot: Probot;

  const receivePr = async (id: string, overrides: PayloadOverrides = {}): Promise<void> => {
    await probot.receive({ id, name: 'pull_request', payload: prOpenedPayload(overrides) as never });
  };

  const receiveIssue = async (id: string, overrides: PayloadOverrides = {}): Promise<void> => {
    await probot.receive({ id, name: 'issues', payload: issuesOpenedPayload(overrides) as never });
  };

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

  it('greets an author with no earlier pull request as first time', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);
    mockEarlierItems('pr', 0);
    const commentScope = mockComment(PR_NUMBER, 'Thanks for opening your first pull request, @octocat!');

    await receivePr('evt-first-pr');

    expect(commentScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('greets an author with no earlier issue as first time', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);
    mockEarlierItems('issue', 0);
    const commentScope = mockComment(ISSUE_NUMBER, 'Thanks for opening your first issue, @octocat!');

    await receiveIssue('evt-first-issue');

    expect(commentScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('greets an author with earlier pull requests as returning', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);
    mockEarlierItems('pr', 3);
    const commentScope = mockComment(PR_NUMBER, 'Thanks for the pull request, @octocat!');

    await receivePr('evt-returning-pr');

    expect(commentScope.isDone()).toBe(true);
  });

  it('greets an author with earlier issues as returning', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);
    mockEarlierItems('issue', 1);
    const commentScope = mockComment(ISSUE_NUMBER, 'Thanks for filing this, @octocat!');

    await receiveIssue('evt-returning-issue');

    expect(commentScope.isDone()).toBe(true);
  });

  it('uses the configured message of the resolved bucket', async () => {
    mockInstallationToken();
    mockConfig(withSettings([
      'first_time:',
      '  pull_request: "Welcome aboard, @{{user}}."',
      'returning:',
      '  pull_request: "Good to see you again, @{{user}}."',
    ]));
    mockEarlierItems('pr', 2);
    const commentScope = mockComment(PR_NUMBER, 'Good to see you again, @octocat.');

    await receivePr('evt-custom-returning');

    expect(commentScope.isDone()).toBe(true);
  });

  it('interpolates {{user}}, {{repo}}, {{number}} and {{title}}', async () => {
    mockInstallationToken();
    mockConfig(withSettings([
      'first_time:',
      '  issue: "@{{user}} opened #{{number}} on {{repo}}: {{title}}"',
    ]));
    mockEarlierItems('issue', 0);
    const commentScope = mockComment(ISSUE_NUMBER, '@octocat opened #7 on widgets: Crash on save');

    await receiveIssue('evt-interpolate', { title: 'Crash on save' });

    expect(commentScope.isDone()).toBe(true);
  });

  it('posts nothing for a first-timer when that greeting is false, after looking up the bucket', async () => {
    mockInstallationToken();
    mockConfig(withSettings(['first_time:', '  issue: false']));
    const searchScope = mockEarlierItems('issue', 0);

    await receiveIssue('evt-first-issue-off');

    expect(searchScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('treats an empty message as switched off', async () => {
    mockInstallationToken();
    mockConfig(withSettings(['returning:', '  pull_request: ""']));
    mockEarlierItems('pr', 4);

    await receivePr('evt-returning-pr-empty');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('switches a whole bucket off with false', async () => {
    mockInstallationToken();
    mockConfig(withSettings(['returning: false']));
    mockEarlierItems('pr', 4);

    await receivePr('evt-returning-bucket-off');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips the lookup when both greetings for the event are off', async () => {
    mockInstallationToken();
    mockConfig(withSettings(['first_time:', '  issue: false', 'returning:', '  issue: false']));

    await receiveIssue('evt-both-off');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips the lookup when both buckets share one message', async () => {
    mockInstallationToken();
    mockConfig(withSettings([
      'first_time:',
      '  pull_request: "Thanks, @{{user}}!"',
      'returning:',
      '  pull_request: "Thanks, @{{user}}!"',
    ]));
    const commentScope = mockComment(PR_NUMBER, 'Thanks, @octocat!');

    await receivePr('evt-shared-message');

    expect(commentScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips the greeting without failing when the lookup fails', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);
    mockEarlierItems('pr', 0, 500);

    await expect(receivePr('evt-lookup-fails')).resolves.toBeUndefined();

    expect(nock.pendingMocks()).toEqual([]);
  });

  describe('draft pull requests', () => {
    it('does not greet a pull request opened as a draft', async () => {
      mockInstallationToken();
      mockConfig(enabledOnlyYaml);

      await receivePr('evt-draft-opened', { draft: true });

      expect(nock.pendingMocks()).toEqual([]);
    });

    it('greets when the pull request becomes ready for review', async () => {
      mockInstallationToken();
      mockConfig(enabledOnlyYaml);
      mockComments(['An unrelated comment']);
      mockEarlierItems('pr', 0);
      const commentScope = mockComment(PR_NUMBER, 'Thanks for opening your first pull request, @octocat!');

      await receivePr('evt-ready', { action: 'ready_for_review' });

      expect(commentScope.isDone()).toBe(true);
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('does not greet again when a welcome notice is already on the pull request', async () => {
      mockInstallationToken();
      mockConfig(enabledOnlyYaml);
      const commentsScope = mockComments([`Thanks for opening your first pull request, @octocat!\n\n${MARKER}`]);

      await receivePr('evt-ready-again', { action: 'ready_for_review' });

      expect(commentsScope.isDone()).toBe(true);
      expect(nock.pendingMocks()).toEqual([]);
    });
  });

  describe('exempt_roles', () => {
    it('greets nobody whose role is exempt, before any lookup', async () => {
      mockInstallationToken();
      mockConfig(withSettings(['exempt_roles: [admin, maintain, write]']));
      const permissionScope = mockPermission('maintain');

      await receivePr('evt-exempt');

      expect(permissionScope.isDone()).toBe(true);
      expect(nock.pendingMocks()).toEqual([]);
    });

    it('still greets an author whose role is not exempt', async () => {
      mockInstallationToken();
      mockConfig(withSettings(['exempt_roles: [admin, maintain, write]']));
      mockPermission('read');
      mockEarlierItems('pr', 0);
      const commentScope = mockComment(PR_NUMBER, 'Thanks for opening your first pull request, @octocat!');

      await receivePr('evt-not-exempt');

      expect(commentScope.isDone()).toBe(true);
      expect(nock.pendingMocks()).toEqual([]);
    });
  });

  describe('author_association (no longer supported)', () => {
    it('ignores a non-empty list and greets by lookup', async () => {
      mockInstallationToken();
      mockConfig(withSettings(['returning:', '  author_association: [MEMBER]']));
      mockEarlierItems('pr', 2);
      const commentScope = mockComment(PR_NUMBER, 'Thanks for the pull request, @octocat!');

      await receivePr('evt-association-ignored');

      expect(commentScope.isDone()).toBe(true);
    });

    it('still treats an empty list as the bucket switched off', async () => {
      mockInstallationToken();
      mockConfig(withSettings(['returning:', '  author_association: []']));
      mockEarlierItems('pr', 2);

      await receivePr('evt-association-empty');

      expect(nock.pendingMocks()).toEqual([]);
    });
  });

  it('does nothing on pull_request.opened when the sender is a bot', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    await receivePr('evt-bot-pr', { senderType: 'Bot' });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on issues.opened when the sender is a bot', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    await receiveIssue('evt-bot-issue', { senderType: 'Bot' });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on issues.opened when the issue has no user (ghost)', async () => {
    mockInstallationToken();
    mockConfig(enabledOnlyYaml);

    await receiveIssue('evt-ghost', { user: null });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await receivePr('evt-no-config');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when welcome is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - stale\n');

    await receiveIssue('evt-not-listed');

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('falls back to defaults and emits a warning when settings.welcome is malformed', async () => {
    mockInstallationToken();
    mockConfig(withSettings(['first_time:', '  pull_request: 42']));
    mockEarlierItems('pr', 0);
    const commentScope = mockComment(PR_NUMBER, 'Thanks for opening your first pull request, @octocat!');

    await receivePr('evt-malformed-settings');

    expect(commentScope.isDone()).toBe(true);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Invalid settings for subscriber "welcome"'),
      { file: '.github/carson.yml' },
    );
  });

  it('does nothing when carson.yml fails schema validation', async () => {
    mockInstallationToken();
    mockConfig('version: 99\nsubscribers:\n  - welcome\n');

    await receivePr('evt-invalid-schema');

    expect(nock.pendingMocks()).toEqual([]);
  });
});
