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
const ITEM_NUMBER = 42;
const COMMENT_MARKER = '<!-- carson:template-enforcer -->';

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

interface CommentInput {
  body: string;
  userType?: string;
}

const mockListComments = (comments: CommentInput[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/issues/${ITEM_NUMBER}/comments`)
    .query({ per_page: '100' })
    .reply(200, comments.map((c, i) => ({
      id: 9000 + i,
      body: c.body,
      user: { login: 'carson[bot]', type: c.userType ?? 'Bot' },
    })));
};

const mockAddLabels = (label: string): nock.Scope => {
  return nock('https://api.github.com')
    .post(`/repos/acme/widgets/issues/${ITEM_NUMBER}/labels`, (body: { labels: string[] }) => {
      expect(body.labels).toEqual([label]);
      return true;
    })
    .reply(200, []);
};

const mockRemoveLabel = (label: string): nock.Scope => {
  return nock('https://api.github.com')
    .delete(`/repos/acme/widgets/issues/${ITEM_NUMBER}/labels/${encodeURIComponent(label)}`)
    .reply(200, []);
};

const mockCreateComment = (verify: (body: { body: string }) => boolean): nock.Scope => {
  return nock('https://api.github.com')
    .post(`/repos/acme/widgets/issues/${ITEM_NUMBER}/comments`, verify)
    .reply(201, { id: 1, body: '' });
};

interface IssueOverrides {
  action?: 'opened' | 'edited';
  body?: string;
  title?: string;
  user?: { login: string } | null;
  labels?: string[];
  senderType?: string;
}

const issuePayload = (overrides: IssueOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  issue: {
    number: ITEM_NUMBER,
    body: overrides.body ?? '',
    title: overrides.title ?? 'Something is broken',
    user: overrides.user === undefined ? { login: 'octocat' } : overrides.user,
    labels: (overrides.labels ?? []).map((name) => ({ name })),
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
  ...(overrides.action === 'edited'
    ? { changes: { body: { from: 'old body' } } }
    : {}),
});

interface PrOverrides {
  action?: 'opened' | 'edited';
  body?: string;
  title?: string;
  user?: { login: string } | null;
  labels?: string[];
  senderType?: string;
}

const prPayload = (overrides: PrOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: ITEM_NUMBER,
    draft: false,
    head: { sha: 'abc1234', ref: 'feature/x' },
    base: { ref: 'main' },
    body: overrides.body ?? '',
    title: overrides.title ?? 'Fix the thing',
    user: overrides.user === undefined ? { login: 'octocat' } : overrides.user,
    labels: (overrides.labels ?? []).map((name) => ({ name })),
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
  ...(overrides.action === 'edited'
    ? { changes: { body: { from: 'old body' } } }
    : {}),
});

const buildConfig = (typeBody: string): string => [
  'version: 1',
  'subscribers:',
  '  - template-enforcer',
  'settings:',
  '  template-enforcer:',
  typeBody,
  '',
].join('\n');

const ISSUES_REQUIRED_SECTION = [
  '    issues:',
  '      required_sections: ["## Steps to reproduce", "## Expected behavior"]',
].join('\n');

describe('template-enforcer subscriber (via app)', () => {
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

  it('does nothing when template-enforcer is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-not-enabled',
      name: 'issues',
      payload: issuePayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on an issue event when the issues subsection is absent', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    pull_requests:',
      '      min_length: 30',
    ].join('\n')));

    await probot.receive({
      id: 'evt-no-issues-section',
      name: 'issues',
      payload: issuePayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing on a PR event when the pull_requests subsection is absent', async () => {
    mockInstallationToken();
    mockConfig(buildConfig(ISSUES_REQUIRED_SECTION));

    await probot.receive({
      id: 'evt-no-pr-section',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('labels and comments an issue that is missing a required section', async () => {
    mockInstallationToken();
    mockConfig(buildConfig(ISSUES_REQUIRED_SECTION));
    mockListComments([]);
    const commentScope = mockCreateComment((body) => {
      expect(body.body).toContain('Required section missing: `## Steps to reproduce`');
      expect(body.body).toContain('Required section missing: `## Expected behavior`');
      expect(body.body).toContain('@octocat');
      expect(body.body).toContain('this issue');
      expect(body.body.endsWith(COMMENT_MARKER)).toBe(true);
      return true;
    });
    const addScope = mockAddLabels('needs-template');

    await probot.receive({
      id: 'evt-issue-missing-section',
      name: 'issues',
      payload: issuePayload({ body: 'something broke' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('does nothing when an issue with no prior label has no violations', async () => {
    mockInstallationToken();
    mockConfig(buildConfig(ISSUES_REQUIRED_SECTION));

    await probot.receive({
      id: 'evt-issue-clean',
      name: 'issues',
      payload: issuePayload({
        body: '## Steps to reproduce\n1. do x\n## Expected behavior\nshould work',
      }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('removes the label when a previously flagged issue is now compliant', async () => {
    mockInstallationToken();
    mockConfig(buildConfig(ISSUES_REQUIRED_SECTION));
    const removeScope = mockRemoveLabel('needs-template');

    await probot.receive({
      id: 'evt-issue-fixed',
      name: 'issues',
      payload: issuePayload({
        action: 'edited',
        body: '## Steps to reproduce\n1. do x\n## Expected behavior\nshould work',
        labels: ['needs-template'],
      }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('adds the label when a prior carson comment exists but the label was manually removed', async () => {
    mockInstallationToken();
    mockConfig(buildConfig(ISSUES_REQUIRED_SECTION));
    mockListComments([{ body: `prior\n\n${COMMENT_MARKER}`, userType: 'Bot' }]);
    const addScope = mockAddLabels('needs-template');

    await probot.receive({
      id: 'evt-issue-relabel',
      name: 'issues',
      payload: issuePayload({
        action: 'edited',
        body: 'still broken',
      }) as never,
    });

    expect(addScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does not re-post when a prior carson comment exists and the label is already present', async () => {
    mockInstallationToken();
    mockConfig(buildConfig(ISSUES_REQUIRED_SECTION));
    mockListComments([{ body: `prior\n\n${COMMENT_MARKER}`, userType: 'Bot' }]);

    await probot.receive({
      id: 'evt-issue-stable',
      name: 'issues',
      payload: issuePayload({
        body: 'still missing sections',
        labels: ['needs-template'],
      }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('flags an issue whose body is below min_length', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    issues:',
      '      min_length: 50',
    ].join('\n')));
    mockListComments([]);
    const commentScope = mockCreateComment((body) => {
      expect(body.body).toContain('Description too short (minimum 50 characters).');
      return true;
    });
    const addScope = mockAddLabels('needs-template');

    await probot.receive({
      id: 'evt-issue-short',
      name: 'issues',
      payload: issuePayload({ body: 'too short' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('flags an issue when a require regex rule does not match', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    issues:',
      '      rules:',
      '        - pattern: "fixes #[0-9]+"',
      '          description: "Reference an issue with fixes #N"',
    ].join('\n')));
    mockListComments([]);
    const commentScope = mockCreateComment((body) => {
      expect(body.body).toContain('Reference an issue with fixes #N');
      return true;
    });
    const addScope = mockAddLabels('needs-template');

    await probot.receive({
      id: 'evt-issue-rule-require',
      name: 'issues',
      payload: issuePayload({ body: 'no reference here' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('flags an issue when a forbid regex rule matches', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    issues:',
      '      rules:',
      '        - pattern: "lorem ipsum"',
      '          description: "Do not paste placeholder text"',
      '          mode: forbid',
    ].join('\n')));
    mockListComments([]);
    const commentScope = mockCreateComment((body) => {
      expect(body.body).toContain('Do not paste placeholder text');
      return true;
    });
    const addScope = mockAddLabels('needs-template');

    await probot.receive({
      id: 'evt-issue-rule-forbid',
      name: 'issues',
      payload: issuePayload({ body: 'this is lorem ipsum content' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('skips an invalid regex rule but still evaluates the others', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    issues:',
      '      rules:',
      '        - pattern: "[unclosed"',
      '          description: "Broken rule"',
      '        - pattern: "fixes"',
      '          description: "Must mention fixes"',
    ].join('\n')));
    mockListComments([]);
    const commentScope = mockCreateComment((body) => {
      expect(body.body).toContain('Must mention fixes');
      expect(body.body).not.toContain('Broken rule');
      return true;
    });
    const addScope = mockAddLabels('needs-template');

    await probot.receive({
      id: 'evt-issue-bad-regex',
      name: 'issues',
      payload: issuePayload({ body: 'no reference here' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('does nothing when every regex rule passes', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    issues:',
      '      rules:',
      '        - pattern: "fixes"',
      '          description: "Must mention fixes"',
      '        - pattern: "lorem"',
      '          description: "No placeholder"',
      '          mode: forbid',
    ].join('\n')));

    await probot.receive({
      id: 'evt-issue-rules-pass',
      name: 'issues',
      payload: issuePayload({ body: 'this PR fixes the issue properly' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('honors custom label name and message', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    label: "needs-info"',
      '    message: "@{{user}} please update this {{type}}. Missing: {{violations}}"',
      '    issues:',
      '      required_sections: ["## Steps"]',
    ].join('\n')));
    mockListComments([]);
    const commentScope = mockCreateComment((body) => {
      expect(body.body).toContain('@octocat please update this issue.');
      expect(body.body).toContain('Required section missing: `## Steps`');
      return true;
    });
    const addScope = mockAddLabels('needs-info');

    await probot.receive({
      id: 'evt-custom',
      name: 'issues',
      payload: issuePayload({ body: 'no steps' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('flags a PR with missing sections', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    pull_requests:',
      '      required_sections: ["## Summary", "## Test plan"]',
    ].join('\n')));
    mockListComments([]);
    const commentScope = mockCreateComment((body) => {
      expect(body.body).toContain('this pull request');
      expect(body.body).toContain('Required section missing: `## Summary`');
      expect(body.body).toContain('Required section missing: `## Test plan`');
      return true;
    });
    const addScope = mockAddLabels('needs-template');

    await probot.receive({
      id: 'evt-pr-missing',
      name: 'pull_request',
      payload: prPayload({ body: 'just a description', labels: ['bug'] }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('does nothing when the sender is a bot', async () => {
    await probot.receive({
      id: 'evt-bot',
      name: 'issues',
      payload: issuePayload({ senderType: 'Bot' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('matches required sections case-insensitively', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    issues:',
      '      required_sections: ["## Steps to Reproduce"]',
    ].join('\n')));

    await probot.receive({
      id: 'evt-case-insensitive',
      name: 'issues',
      payload: issuePayload({ body: '## steps to reproduce\n1. open the app' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('treats an empty body as a min_length violation', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    issues:',
      '      min_length: 1',
    ].join('\n')));
    mockListComments([]);
    const commentScope = mockCreateComment(() => true);
    const addScope = mockAddLabels('needs-template');

    await probot.receive({
      id: 'evt-empty',
      name: 'issues',
      payload: issuePayload({ body: '' }) as never,
    });

    expect(commentScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({
      id: 'evt-missing',
      name: 'issues',
      payload: issuePayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the issue has no user (ghost)', async () => {
    await probot.receive({
      id: 'evt-ghost',
      name: 'issues',
      payload: issuePayload({ user: null, body: 'no sections' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the PR has no user (ghost)', async () => {
    mockInstallationToken();
    mockConfig(buildConfig([
      '    pull_requests:',
      '      min_length: 10',
    ].join('\n')));

    await probot.receive({
      id: 'evt-ghost-pr',
      name: 'pull_request',
      payload: prPayload({ user: null }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});
