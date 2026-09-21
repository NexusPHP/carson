import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import { type ScheduledContext, ScheduledRegistrar } from '../../src/scheduled.js';
import app from '../../src/app.js';
import { generateKeyPairSync } from 'node:crypto';
import { logger } from '../../src/logger.js';
import nock from 'nock';
import { NoResponseCloserSubscriber } from '../../src/subscribers/no-response-closer.js';
import { resetConfigCache } from '../../src/configuration/cache.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const API = 'https://api.github.com';
const INSTALLATION_ID = 12345;
const ITEM_NUMBER = 42;

const mockInstallationToken = (): void => {
  nock(API)
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' });
};

const mockConfig = (yaml: string): void => {
  nock(API).get('/repos/acme/widgets/contents/.github%2Fcarson.yml').reply(200, yaml);
};

const mockRemoveLabel = (label: string): nock.Scope =>
  nock(API).delete(`/repos/acme/widgets/issues/${ITEM_NUMBER}/labels/${encodeURIComponent(label)}`).reply(200, []);

const responseConfig = (settings: string[], subscribers = ['auto-labeler', 'no-response-closer']): string => [
  'version: 1',
  'subscribers:',
  ...subscribers.map((id) => `  - ${id}`),
  'settings:',
  '  no-response-closer:',
  ...settings.map((line) => `    ${line}`),
  '',
].join('\n');

const WAITING_RULE = ['rules:', '  - label: waiting for info', '    unlabel_on_response: true'];

interface ResponseOverrides {
  sender?: string;
  senderType?: string;
  author?: string | null;
  labels?: string[];
  state?: 'open' | 'closed';
  isPr?: boolean;
}

const item = (overrides: ResponseOverrides): Record<string, unknown> => ({
  number: ITEM_NUMBER,
  state: overrides.state ?? 'open',
  user: overrides.author === null ? null : { login: overrides.author ?? 'octocat' },
  labels: (overrides.labels ?? ['waiting for info']).map((name) => ({ name })),
  title: 'Something is broken',
});

const base = (overrides: ResponseOverrides): Record<string, unknown> => ({
  installation: { id: INSTALLATION_ID },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { login: overrides.sender ?? 'octocat', type: overrides.senderType ?? 'User' },
});

const commentPayload = (overrides: ResponseOverrides = {}): Record<string, unknown> => ({
  ...base(overrides),
  action: 'created',
  issue: { ...item(overrides), ...(overrides.isPr === true ? { pull_request: { url: 'https://example.test' } } : {}) },
  comment: { id: 1, body: 'Here are the details.', user: { login: overrides.sender ?? 'octocat' } },
});

const pushPayload = (overrides: ResponseOverrides = {}): Record<string, unknown> => ({
  ...base(overrides),
  action: 'synchronize',
  pull_request: { ...item(overrides), draft: false, head: { sha: 'abc1234', ref: 'feature/x' }, base: { ref: 'main' } },
});

const reviewCommentPayload = (overrides: ResponseOverrides = {}): Record<string, unknown> => ({
  ...base(overrides),
  action: 'created',
  pull_request: { ...item(overrides), draft: false, head: { sha: 'abc1234', ref: 'feature/x' }, base: { ref: 'main' } },
  comment: { id: 2, body: 'Done.', user: { login: overrides.sender ?? 'octocat' } },
});

describe('no-response-closer subscriber (author responses, via app)', () => {
  let probot: Probot;

  const receive = async (id: string, name: string, payload: Record<string, unknown>): Promise<void> => {
    await probot.receive({ id, name, payload } as never);
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
      Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }),
    });
    await probot.load(app);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('removes the label when the author comments', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));
    const removeScope = mockRemoveLabel('waiting for info');

    await receive('evt-author-comment', 'issue_comment', commentPayload());

    expect(removeScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('removes the label when the author pushes to the pull request', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));
    const removeScope = mockRemoveLabel('waiting for info');

    await receive('evt-author-push', 'pull_request', pushPayload());

    expect(removeScope.isDone()).toBe(true);
  });

  it('removes the label when the author replies in a review thread', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));
    const removeScope = mockRemoveLabel('waiting for info');

    await receive('evt-author-review-reply', 'pull_request_review_comment', reviewCommentPayload());

    expect(removeScope.isDone()).toBe(true);
  });

  it('matches the carried label case-insensitively', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));
    const removeScope = mockRemoveLabel('waiting for info');

    await receive('evt-label-case', 'issue_comment', commentPayload({ labels: ['Waiting For Info'] }));

    expect(removeScope.isDone()).toBe(true);
  });

  it('accepts unlabel_on_response at the top level for the single-rule form', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(['unlabel_on_response: true']));
    const removeScope = mockRemoveLabel('needs-info');

    await receive('evt-top-level', 'issue_comment', commentPayload({ labels: ['needs-info'] }));

    expect(removeScope.isDone()).toBe(true);
  });

  it('ignores a comment by someone other than the author', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));

    await receive('evt-other-comment', 'issue_comment', commentPayload({ sender: 'maintainer' }));

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores a push by someone other than the author', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));

    await receive('evt-other-push', 'pull_request', pushPayload({ sender: 'maintainer' }));

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores a pull request whose author is a ghost', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));

    await receive('evt-ghost-author', 'pull_request', pushPayload({ author: null }));

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores bot senders', async () => {
    await receive('evt-bot', 'issue_comment', commentPayload({ senderType: 'Bot' }));

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores closed items', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));

    await receive('evt-closed', 'issue_comment', commentPayload({ state: 'closed' }));

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('leaves the label when the rule has not opted in', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(['rules:', '  - label: waiting for info']));

    await receive('evt-not-opted-in', 'issue_comment', commentPayload());

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('leaves the label when the item does not carry it', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE));

    await receive('evt-no-label', 'issue_comment', commentPayload({ labels: ['bug'] }));

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('respects the rule scope: an issues-only rule ignores a pull request', async () => {
    mockInstallationToken();
    mockConfig(responseConfig([...WAITING_RULE, '    only: issues']));

    await receive('evt-scope', 'issue_comment', commentPayload({ isPr: true }));

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('applies a pull-requests-only rule to a comment on a pull request', async () => {
    mockInstallationToken();
    mockConfig(responseConfig([...WAITING_RULE, '    only: pull_requests']));
    const removeScope = mockRemoveLabel('waiting for info');

    await receive('evt-scope-pr', 'issue_comment', commentPayload({ isPr: true }));

    expect(removeScope.isDone()).toBe(true);
  });

  it('leaves the label when auto-labeler is not enabled to serve the request', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(WAITING_RULE, ['no-response-closer']));

    await receive('evt-no-owner', 'issue_comment', commentPayload());

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the settings conflict', async () => {
    mockInstallationToken();
    mockConfig(responseConfig(['label: needs-info', ...WAITING_RULE]));

    await receive('evt-conflict', 'issue_comment', commentPayload());

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when no-response-closer is not enabled', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - issue-intake\n');

    await receive('evt-not-enabled', 'issue_comment', commentPayload());

    expect(nock.pendingMocks()).toEqual([]);
  });
});

interface ItemShape {
  number: number;
  updated_at: string;
  labels?: ({ name: string } | string)[];
  pull_request?: { url: string };
  user?: { login: string } | null;
  title?: string;
}

interface Harness {
  context: ScheduledContext;
  updateMock: ReturnType<typeof vi.fn>;
  commentMock: ReturnType<typeof vi.fn>;
  configMock: ReturnType<typeof vi.fn>;
  paginateMock: ReturnType<typeof vi.fn>;
}

const NOW = new Date('2026-06-30T00:00:00Z').getTime();
const DAYS_AGO = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const makeStubLog = (): Record<string, unknown> => {
  const log: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log['child'] = vi.fn().mockReturnValue(log);

  return log;
};

const makeHarness = (items: ItemShape[] | Record<string, ItemShape[]>, config: unknown): Harness => {
  const updateMock = vi.fn().mockResolvedValue({});
  const commentMock = vi.fn().mockResolvedValue({});
  const configMock = vi.fn().mockResolvedValue(config);
  const paginate = vi.fn().mockImplementation(async (_fn: unknown, params: { q: string }) => {
    const label = /label:"([^"]+)"/.exec(params.q)?.[1] ?? '';
    const found = Array.isArray(items) ? items : items[label] ?? [];

    return await Promise.resolve(found.map((i) => ({
      number: i.number,
      updated_at: i.updated_at,
      labels: i.labels ?? [{ name: 'needs-info' }],
      pull_request: i.pull_request,
      user: i.user === undefined ? { login: 'octocat' } : i.user,
      title: i.title ?? 'Something is broken',
    })));
  });

  const context: ScheduledContext = {
    octokit: {
      paginate,
      rest: {
        issues: {
          update: updateMock,
          createComment: commentMock,
        },
        search: {
          issuesAndPullRequests: 'search-fn',
        },
      },
    } as never,
    log: makeStubLog() as never,
    payload: { schedule: '0 * * * *', workflow: '.github/workflows/cron.yml' },
    repo: () => ({ owner: 'acme', repo: 'widgets' }),
    config: configMock,
  };

  return { context, updateMock, commentMock, configMock, paginateMock: paginate };
};

const runScheduled = async (context: ScheduledContext): Promise<void> => {
  const subscriber = new NoResponseCloserSubscriber();
  const registrar = new ScheduledRegistrar();
  subscriber.registerScheduled(registrar);
  for (const handler of registrar.handlers) {
    await handler(context);
  }
};

describe('no-response-closer subscriber', () => {
  beforeEach(() => {
    resetConfigCache();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    logger.init(makeStubLog() as never);
  });

  afterEach(() => {
    resetConfigCache();
    logger.reset();
    vi.useRealTimers();
  });

  const ENABLED_CONFIG = { version: 1, subscribers: ['no-response-closer'] };

  it('closes labeled items whose updated_at is older than the default 14-day threshold', async () => {
    const { context, updateMock } = makeHarness(
      [
        { number: 1, updated_at: DAYS_AGO(20) },
        { number: 2, updated_at: DAYS_AGO(7) },
      ],
      ENABLED_CONFIG,
    );

    await runScheduled(context);

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 1,
      state: 'closed',
      state_reason: 'not_planned',
    });
  });

  it('honors a custom days_until_close setting', async () => {
    const { context, updateMock } = makeHarness(
      [
        { number: 10, updated_at: DAYS_AGO(40) },
        { number: 11, updated_at: DAYS_AGO(20) },
      ],
      { ...ENABLED_CONFIG, settings: { 'no-response-closer': { days_until_close: 30 } } },
    );

    await runScheduled(context);

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 10 }));
  });

  it('searches for open items with the configured label past the inactivity cutoff, oldest first', async () => {
    const { context } = makeHarness(
      [],
      { ...ENABLED_CONFIG, settings: { 'no-response-closer': { label: 'awaiting-info' } } },
    );

    await runScheduled(context);

    expect(context.octokit.paginate).toHaveBeenCalledWith('search-fn', {
      q: 'repo:acme/widgets is:open label:"awaiting-info" updated:<2026-06-16T00:00:00Z',
      advanced_search: 'true',
      sort: 'updated',
      order: 'asc',
      per_page: 100,
    });
  });

  it('skips items carrying an exempt label', async () => {
    const { context, updateMock } = makeHarness(
      [{
        number: 1,
        updated_at: DAYS_AGO(40),
        labels: [{ name: 'needs-info' }, { name: 'pinned' }],
      }],
      { ...ENABLED_CONFIG, settings: { 'no-response-closer': { exempt_labels: ['pinned'] } } },
    );

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('handles labels in string form for exemption checks', async () => {
    const { context, updateMock } = makeHarness(
      [{ number: 1, updated_at: DAYS_AGO(40), labels: ['needs-info', 'security'] }],
      { ...ENABLED_CONFIG, settings: { 'no-response-closer': { exempt_labels: ['security'] } } },
    );

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('posts the default close message before closing when close_message is not configured', async () => {
    const { context, updateMock, commentMock } = makeHarness(
      [{ number: 5, updated_at: DAYS_AGO(20) }],
      ENABLED_CONFIG,
    );

    await runScheduled(context);

    expect(commentMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 5,
      body: 'Closing this issue: no response for 14 days after information was requested. Comment with the requested details and it can be reopened.',
    });
    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('posts an interpolated close_message before closing when configured', async () => {
    const { context, updateMock, commentMock } = makeHarness(
      [{ number: 7, updated_at: DAYS_AGO(20) }],
      {
        ...ENABLED_CONFIG,
        settings: {
          'no-response-closer': {
            close_message: 'Closing @{{user}}\'s {{type}} #{{number}} on {{repo}} after {{days_until_close}} days.',
          },
        },
      },
    );

    await runScheduled(context);

    expect(commentMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 7,
      body: 'Closing @octocat\'s issue #7 on widgets after 14 days.',
    });
    expect(updateMock).toHaveBeenCalledOnce();
    const [commentOrder = Number.NaN] = commentMock.mock.invocationCallOrder;
    const [updateOrder = Number.NaN] = updateMock.mock.invocationCallOrder;
    expect(commentOrder).toBeLessThan(updateOrder);
  });

  it('leaves {{user}} verbatim when the item has no user (ghost)', async () => {
    const { context, commentMock } = makeHarness(
      [{ number: 9, updated_at: DAYS_AGO(20), user: null }],
      {
        ...ENABLED_CONFIG,
        settings: {
          'no-response-closer': {
            close_message: 'Hello @{{user}}, closing #{{number}}.',
          },
        },
      },
    );

    await runScheduled(context);

    expect(commentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Hello @{{user}}, closing #9.',
    }));
  });

  it('closes a PR without setting state_reason', async () => {
    const { context, updateMock } = makeHarness(
      [{ number: 42, updated_at: DAYS_AGO(20), pull_request: { url: 'https://example/42' } }],
      ENABLED_CONFIG,
    );

    await runScheduled(context);

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 42,
      state: 'closed',
    });
  });

  it('uses "pull request" for the {{type}} placeholder on PRs', async () => {
    const { context, commentMock } = makeHarness(
      [{
        number: 42,
        updated_at: DAYS_AGO(20),
        pull_request: { url: 'https://example/42' },
      }],
      {
        ...ENABLED_CONFIG,
        settings: {
          'no-response-closer': { close_message: 'Closing this {{type}}.' },
        },
      },
    );

    await runScheduled(context);

    expect(commentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Closing this pull request.',
    }));
  });

  it('does nothing when subscriber is not enabled', async () => {
    const { context, updateMock } = makeHarness(
      [{ number: 1, updated_at: DAYS_AGO(40) }],
      { version: 1, subscribers: ['welcome'] },
    );

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does nothing when carson.yml is missing', async () => {
    const { context, updateMock } = makeHarness(
      [{ number: 1, updated_at: DAYS_AGO(40) }],
      null,
    );

    await runScheduled(context);

    expect(updateMock).not.toHaveBeenCalled();
  });

  describe('rules', () => {
    const withSettings = (settings: Record<string, unknown>): unknown => ({
      ...ENABLED_CONFIG,
      settings: { 'no-response-closer': settings },
    });

    const queries = (paginateMock: ReturnType<typeof vi.fn>): string[] =>
      paginateMock.mock.calls.map((call: unknown[]) => (call[1] as { q: string }).q);

    it('runs each rule with its own threshold, message, and label', async () => {
      const { context, updateMock, commentMock } = makeHarness(
        {
          'waiting for info': [{ number: 1, updated_at: DAYS_AGO(20) }, { number: 2, updated_at: DAYS_AGO(5) }],
          'needs template': [{ number: 3, updated_at: DAYS_AGO(5) }],
        },
        withSettings({
          rules: [
            { label: 'waiting for info' },
            { label: 'needs template', days_until_close: 3, close_message: 'Closed for {{label}} after {{days_until_close}} days.' },
          ],
        }),
      );

      await runScheduled(context);

      expect(updateMock.mock.calls.map((call: unknown[]) => (call[0] as { issue_number: number }).issue_number)).toEqual([1, 3]);
      expect(commentMock).toHaveBeenLastCalledWith(expect.objectContaining({
        issue_number: 3,
        body: 'Closed for needs template after 3 days.',
      }));
    });

    it('uses top-level keys as defaults and lets a rule replace exempt_labels', async () => {
      const pinned = [{ name: 'pinned' }];
      const { context, updateMock, commentMock } = makeHarness(
        {
          inherits: [{ number: 1, updated_at: DAYS_AGO(40), labels: pinned }, { number: 2, updated_at: DAYS_AGO(20) }],
          replaces: [{ number: 3, updated_at: DAYS_AGO(40), labels: pinned }],
        },
        withSettings({
          days_until_close: 30,
          close_message: 'Shared message.',
          exempt_labels: ['pinned'],
          rules: [{ label: 'inherits' }, { label: 'replaces', exempt_labels: [] }],
        }),
      );

      await runScheduled(context);

      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(commentMock).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 3, body: 'Shared message.' }));
    });

    it('scopes the search with only', async () => {
      const { context, paginateMock } = makeHarness([], withSettings({
        rules: [
          { label: 'a', only: 'issues' },
          { label: 'b', only: 'pull_requests' },
          { label: 'c' },
        ],
      }));

      await runScheduled(context);

      const [issues, pulls, both] = queries(paginateMock);

      expect(issues).toContain('is:open is:issue label:"a"');
      expect(pulls).toContain('is:open is:pr label:"b"');
      expect(both).toContain('is:open label:"c"');
    });

    it('closes an item once when a later rule still finds it open', async () => {
      const item = { number: 7, updated_at: DAYS_AGO(20) };
      const { context, updateMock, commentMock } = makeHarness(
        { first: [item], second: [item] },
        withSettings({ rules: [{ label: 'first' }, { label: 'second' }] }),
      );

      await runScheduled(context);

      expect(updateMock).toHaveBeenCalledTimes(1);
      expect(commentMock).toHaveBeenCalledTimes(1);
    });

    it('does nothing when rules is empty', async () => {
      const { context, paginateMock } = makeHarness([{ number: 1, updated_at: DAYS_AGO(20) }], withSettings({ rules: [] }));

      await runScheduled(context);

      expect(paginateMock).not.toHaveBeenCalled();
    });

    it('skips the run when label is combined with rules', async () => {
      const { context, paginateMock } = makeHarness([], withSettings({ label: 'needs-info', rules: [{ label: 'a' }] }));

      await runScheduled(context);

      expect(paginateMock).not.toHaveBeenCalled();
    });

    it('skips the run when two rules share a label, compared case-insensitively', async () => {
      const { context, paginateMock } = makeHarness([], withSettings({ rules: [{ label: 'Needs Template' }, { label: 'needs template' }] }));

      await runScheduled(context);

      expect(paginateMock).not.toHaveBeenCalled();
    });

    it('skips the run when a rule exempts its own label', async () => {
      const { context, paginateMock } = makeHarness([], withSettings({ exempt_labels: ['Stuck'], rules: [{ label: 'stuck' }] }));

      await runScheduled(context);

      expect(paginateMock).not.toHaveBeenCalled();
    });
  });
});
