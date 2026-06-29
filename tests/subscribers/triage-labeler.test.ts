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

interface ReviewInput {
  user: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  author_association?: string;
}

const mockListReviews = (reviews: ReviewInput[]): nock.Scope => {
  return nock('https://api.github.com')
    .get(`/repos/acme/widgets/pulls/${PR_NUMBER}/reviews`)
    .query({ per_page: '100' })
    .reply(200, reviews.map((r, i) => ({
      id: 1000 + i,
      state: r.state,
      user: r.user === null ? null : { login: r.user },
      author_association: r.author_association ?? 'COLLABORATOR',
    })));
};

const mockAddLabels = (label: string): nock.Scope => {
  return nock('https://api.github.com')
    .post(`/repos/acme/widgets/issues/${PR_NUMBER}/labels`, (body: { labels: string[] }) => {
      expect(body.labels).toEqual([label]);
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
  action?: 'opened' | 'reopened' | 'synchronize' | 'ready_for_review' | 'converted_to_draft';
  draft?: boolean;
  labels?: string[];
  senderType?: string;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: overrides.draft ?? false,
    head: { sha: 'abc1234', ref: 'feature/widget' },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User' },
});

const reviewPayload = (
  reviewState: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED',
  reviewer: string,
  overrides: PayloadOverrides & { reviewerAssociation?: string } = {},
): Record<string, unknown> => ({
  action: 'submitted',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: overrides.draft ?? false,
    head: { sha: 'abc1234', ref: 'feature/widget' },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
  },
  review: {
    state: reviewState.toLowerCase(),
    user: { login: reviewer },
    author_association: overrides.reviewerAssociation ?? 'COLLABORATOR',
  },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: overrides.senderType ?? 'User', login: reviewer },
});

const CONFIG_ENABLED = 'version: 1\nsubscribers:\n  - triage-labeler\n';

describe('triage-labeler subscriber (via app)', () => {
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

  it('does nothing when triage-labeler is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-not-enabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('adds needs-review on a non-draft opened PR with no reviews', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-opened',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does not label an opened draft PR', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);

    await probot.receive({
      id: 'evt-opened-draft',
      name: 'pull_request',
      payload: prPayload({ draft: true }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('adds needs-review on ready_for_review when no reviews exist', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-ready',
      name: 'pull_request',
      payload: prPayload({ action: 'ready_for_review' }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('removes the existing managed label when converted to draft', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    const removeScope = mockRemoveLabel('needs-review');

    await probot.receive({
      id: 'evt-converted-draft',
      name: 'pull_request',
      payload: prPayload({
        action: 'converted_to_draft',
        draft: true,
        labels: ['needs-review', 'bug'],
      }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('sets needs-rework when a qualifying reviewer requests changes', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'CHANGES_REQUESTED', author_association: 'COLLABORATOR' }]);
    const removeScope = mockRemoveLabel('needs-review');
    const addScope = mockAddLabels('needs-rework');

    await probot.receive({
      id: 'evt-changes-requested',
      name: 'pull_request_review',
      payload: reviewPayload('CHANGES_REQUESTED', 'alice', { labels: ['needs-review'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('sets approved when the only qualifying review is APPROVED', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'APPROVED', author_association: 'MEMBER' }]);
    const removeScope = mockRemoveLabel('needs-review');
    const addScope = mockAddLabels('approved');

    await probot.receive({
      id: 'evt-approved',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['needs-review'], reviewerAssociation: 'MEMBER' }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('keeps needs-rework when one reviewer approves but anothers latest is CHANGES_REQUESTED', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: 'alice', state: 'CHANGES_REQUESTED', author_association: 'COLLABORATOR' },
      { user: 'bob', state: 'APPROVED', author_association: 'COLLABORATOR' },
    ]);

    await probot.receive({
      id: 'evt-mixed',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'bob', { labels: ['needs-rework'] }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('uses the latest review per reviewer (later APPROVED overrides earlier CHANGES_REQUESTED)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: 'alice', state: 'CHANGES_REQUESTED', author_association: 'COLLABORATOR' },
      { user: 'alice', state: 'APPROVED', author_association: 'COLLABORATOR' },
    ]);
    const removeScope = mockRemoveLabel('needs-rework');
    const addScope = mockAddLabels('approved');

    await probot.receive({
      id: 'evt-later-wins',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['needs-rework'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('ignores reviews from non-qualifying associations', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: 'eve', state: 'APPROVED', author_association: 'CONTRIBUTOR' },
      { user: 'mallory', state: 'CHANGES_REQUESTED', author_association: 'NONE' },
    ]);

    await probot.receive({
      id: 'evt-non-qualifying',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'eve', {
        labels: ['needs-review'],
        reviewerAssociation: 'CONTRIBUTOR',
      }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores reviews from deleted accounts (user is null)', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: null, state: 'APPROVED', author_association: 'COLLABORATOR' },
    ]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-ghost-reviewer',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: [] }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('ignores COMMENTED reviews when computing state', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([
      { user: 'alice', state: 'COMMENTED', author_association: 'COLLABORATOR' },
    ]);
    const addScope = mockAddLabels('needs-review');

    await probot.receive({
      id: 'evt-commented',
      name: 'pull_request_review',
      payload: reviewPayload('COMMENTED', 'alice', { labels: [] }) as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does not touch unrelated labels', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'APPROVED', author_association: 'COLLABORATOR' }]);
    const removeScope = mockRemoveLabel('needs-review');
    const addScope = mockAddLabels('approved');

    await probot.receive({
      id: 'evt-untouched',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['bug', 'area:api', 'needs-review'] }) as never,
    });

    expect(removeScope.isDone()).toBe(true);
    expect(addScope.isDone()).toBe(true);
  });

  it('honors custom label name overrides', async () => {
    mockInstallationToken();
    mockConfig([
      'version: 1',
      'subscribers:',
      '  - triage-labeler',
      'settings:',
      '  triage-labeler:',
      '    needs_review_label: "status: needs review"',
      '    needs_rework_label: "status: changes requested"',
      '    approved_label: "status: ready to merge"',
      '',
    ].join('\n'));
    mockListReviews([]);
    const addScope = mockAddLabels('status: needs review');

    await probot.receive({
      id: 'evt-custom-labels',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(addScope.isDone()).toBe(true);
  });

  it('does nothing when the sender is a bot', async () => {
    await probot.receive({
      id: 'evt-bot',
      name: 'pull_request',
      payload: prPayload({ senderType: 'Bot' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('makes no label API calls when the existing managed label already matches desired', async () => {
    mockInstallationToken();
    mockConfig(CONFIG_ENABLED);
    mockListReviews([{ user: 'alice', state: 'APPROVED', author_association: 'COLLABORATOR' }]);

    await probot.receive({
      id: 'evt-idempotent',
      name: 'pull_request_review',
      payload: reviewPayload('APPROVED', 'alice', { labels: ['approved'] }) as never,
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
