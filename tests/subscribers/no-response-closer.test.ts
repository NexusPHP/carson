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
}

const NOW = new Date('2026-06-30T00:00:00Z').getTime();
const DAYS_AGO = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const makeStubLog = (): Record<string, unknown> => {
  const log: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log['child'] = vi.fn().mockReturnValue(log);

  return log;
};

const makeHarness = (items: ItemShape[], config: unknown): Harness => {
  const updateMock = vi.fn().mockResolvedValue({});
  const commentMock = vi.fn().mockResolvedValue({});
  const configMock = vi.fn().mockResolvedValue(config);
  const paginate = vi.fn().mockResolvedValue(items.map((i) => ({
    number: i.number,
    updated_at: i.updated_at,
    labels: i.labels ?? [{ name: 'needs-info' }],
    pull_request: i.pull_request,
    user: i.user === undefined ? { login: 'octocat' } : i.user,
    title: i.title ?? 'Something is broken',
  })));

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

  return { context, updateMock, commentMock, configMock };
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
      q: 'repo:acme/widgets is:open label:"awaiting-info" updated:<2026-06-16T00:00:00+00:00',
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
    const [commentOrder] = commentMock.mock.invocationCallOrder;
    const [updateOrder] = updateMock.mock.invocationCallOrder;
    expect(commentOrder).toBeDefined();
    expect(updateOrder).toBeDefined();
    expect(commentOrder).toBeLessThan(updateOrder as number);
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

  it('registers no webhook handlers', () => {
    const subscriber = new NoResponseCloserSubscriber();
    const onSpy = vi.fn();
    subscriber.register({ on: onSpy } as never);
    expect(onSpy).not.toHaveBeenCalled();
  });
});
