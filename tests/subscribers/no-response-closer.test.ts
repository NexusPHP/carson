import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ScheduledContext, ScheduledRegistrar } from '../../src/scheduled.js';
import { logger } from '../../src/logger.js';
import { NoResponseCloserSubscriber } from '../../src/subscribers/no-response-closer.js';
import { resetConfigCache } from '../../src/configuration/cache.js';

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

  it('registers no webhook handlers', () => {
    const subscriber = new NoResponseCloserSubscriber();
    const onSpy = vi.fn();
    subscriber.register({ on: onSpy } as never);
    expect(onSpy).not.toHaveBeenCalled();
  });
});
