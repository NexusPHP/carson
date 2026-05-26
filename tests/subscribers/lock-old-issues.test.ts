import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache, setRegisteredSubscribers } from '../../src/configuration/cache.js';
import { type ScheduledContext, ScheduledRegistrar } from '../../src/scheduled.js';
import { LockOldIssuesSubscriber } from '../../src/subscribers/lock-old-issues.js';

interface IssueShape {
  number: number;
  locked?: boolean;
  closed_at: string | null;
  labels?: ({ name: string } | string)[];
  pull_request?: { url: string };
  user?: { login: string } | null;
}

interface Harness {
  context: ScheduledContext;
  lockMock: ReturnType<typeof vi.fn>;
  commentMock: ReturnType<typeof vi.fn>;
  configMock: ReturnType<typeof vi.fn>;
}

const NOW = new Date('2026-01-01T00:00:00Z').getTime();
const DAYS_AGO = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const makeHarness = (issues: IssueShape[], config: unknown): Harness => {
  const lockMock = vi.fn().mockResolvedValue({});
  const commentMock = vi.fn().mockResolvedValue({});
  const configMock = vi.fn().mockResolvedValue(config);
  const paginate = vi.fn().mockResolvedValue(issues.map((i) => ({
    number: i.number,
    locked: i.locked ?? false,
    closed_at: i.closed_at,
    labels: i.labels ?? [],
    pull_request: i.pull_request,
    user: i.user === undefined ? { login: 'octocat' } : i.user,
  })));

  const context: ScheduledContext = {
    octokit: {
      paginate,
      rest: {
        issues: {
          listForRepo: 'listForRepo-fn',
          lock: lockMock,
          createComment: commentMock,
        },
      },
    } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    payload: { schedule: '0 * * * *', workflow: '.github/workflows/cron.yml' },
    repo: () => ({ owner: 'acme', repo: 'widgets' }),
    config: configMock,
  };

  return { context, lockMock, commentMock, configMock };
};

const runScheduled = async (context: ScheduledContext): Promise<void> => {
  const subscriber = new LockOldIssuesSubscriber();
  const registrar = new ScheduledRegistrar();
  subscriber.registerScheduled(registrar);
  for (const handler of registrar.handlers) {
    await handler(context);
  }
};

describe('lock-old-issues subscriber', () => {
  beforeEach(() => {
    setRegisteredSubscribers(['lock-old-issues']);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    resetConfigCache();
    setRegisteredSubscribers([]);
    vi.useRealTimers();
  });

  const ENABLED_CONFIG = { version: 1, subscribers: ['lock-old-issues'] };

  it('locks closed issues older than the default 90-day threshold', async () => {
    const { context, lockMock } = makeHarness(
      [
        { number: 1, closed_at: DAYS_AGO(100) },
        { number: 2, closed_at: DAYS_AGO(30) },
      ],
      ENABLED_CONFIG,
    );

    await runScheduled(context);

    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(lockMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 1,
      lock_reason: 'resolved',
    });
  });

  it('honors a custom days setting', async () => {
    const { context, lockMock } = makeHarness(
      [
        { number: 10, closed_at: DAYS_AGO(40) },
        { number: 11, closed_at: DAYS_AGO(20) },
      ],
      { ...ENABLED_CONFIG, settings: { 'lock-old-issues': { days: 30 } } },
    );

    await runScheduled(context);

    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(lockMock).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 10 }));
  });

  it('honors a custom reason setting', async () => {
    const { context, lockMock } = makeHarness(
      [{ number: 5, closed_at: DAYS_AGO(400) }],
      { ...ENABLED_CONFIG, settings: { 'lock-old-issues': { reason: 'spam' } } },
    );

    await runScheduled(context);

    expect(lockMock).toHaveBeenCalledWith(expect.objectContaining({ lock_reason: 'spam' }));
  });

  it('skips already-locked issues', async () => {
    const { context, lockMock } = makeHarness(
      [{ number: 1, closed_at: DAYS_AGO(400), locked: true }],
      ENABLED_CONFIG,
    );

    await runScheduled(context);

    expect(lockMock).not.toHaveBeenCalled();
  });

  it('skips pull requests', async () => {
    const { context, lockMock } = makeHarness(
      [{ number: 1, closed_at: DAYS_AGO(400), pull_request: { url: 'https://example/1' } }],
      ENABLED_CONFIG,
    );

    await runScheduled(context);

    expect(lockMock).not.toHaveBeenCalled();
  });

  it('skips issues that have never been closed (closed_at null)', async () => {
    const { context, lockMock } = makeHarness(
      [{ number: 1, closed_at: null }],
      ENABLED_CONFIG,
    );

    await runScheduled(context);

    expect(lockMock).not.toHaveBeenCalled();
  });

  it('skips issues carrying an exempt label (object form)', async () => {
    const { context, lockMock } = makeHarness(
      [{ number: 1, closed_at: DAYS_AGO(400), labels: [{ name: 'pinned' }] }],
      { ...ENABLED_CONFIG, settings: { 'lock-old-issues': { exempt_labels: ['pinned'] } } },
    );

    await runScheduled(context);

    expect(lockMock).not.toHaveBeenCalled();
  });

  it('skips issues carrying an exempt label (string form)', async () => {
    const { context, lockMock } = makeHarness(
      [{ number: 1, closed_at: DAYS_AGO(400), labels: ['security'] }],
      { ...ENABLED_CONFIG, settings: { 'lock-old-issues': { exempt_labels: ['security'] } } },
    );

    await runScheduled(context);

    expect(lockMock).not.toHaveBeenCalled();
  });

  it('does nothing when subscriber is not enabled', async () => {
    const { context, lockMock } = makeHarness(
      [{ number: 1, closed_at: DAYS_AGO(400) }],
      { version: 1, subscribers: ['welcome'] },
    );

    await runScheduled(context);

    expect(lockMock).not.toHaveBeenCalled();
  });

  it('does nothing when carson.yml is missing', async () => {
    const { context, lockMock } = makeHarness(
      [{ number: 1, closed_at: DAYS_AGO(400) }],
      null,
    );

    await runScheduled(context);

    expect(lockMock).not.toHaveBeenCalled();
  });

  it('registers no webhook handlers', () => {
    const subscriber = new LockOldIssuesSubscriber();
    const onSpy = vi.fn();
    subscriber.register({ on: onSpy } as never);
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('does not post a comment when no comment setting is provided', async () => {
    const { context, lockMock, commentMock } = makeHarness(
      [{ number: 1, closed_at: DAYS_AGO(100) }],
      ENABLED_CONFIG,
    );

    await runScheduled(context);

    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(commentMock).not.toHaveBeenCalled();
  });

  it('posts an interpolated comment before locking when configured', async () => {
    const { context, lockMock, commentMock } = makeHarness(
      [{ number: 7, closed_at: DAYS_AGO(100) }],
      {
        ...ENABLED_CONFIG,
        settings: {
          'lock-old-issues': {
            comment: 'Locking @{{user}}\'s issue #{{number}} on {{repo}} after {{days}} days.',
          },
        },
      },
    );

    await runScheduled(context);

    expect(commentMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 7,
      body: 'Locking @octocat\'s issue #7 on widgets after 90 days.',
    });
    expect(lockMock).toHaveBeenCalledOnce();
    const [commentOrder] = commentMock.mock.invocationCallOrder;
    const [lockOrder] = lockMock.mock.invocationCallOrder;
    expect(commentOrder).toBeDefined();
    expect(lockOrder).toBeDefined();
    expect(commentOrder).toBeLessThan(lockOrder as number);
  });

  it('leaves {{user}} verbatim when the issue has no user (ghost)', async () => {
    const { context, commentMock } = makeHarness(
      [{ number: 9, closed_at: DAYS_AGO(100), user: null }],
      {
        ...ENABLED_CONFIG,
        settings: {
          'lock-old-issues': {
            comment: 'Hello @{{user}}, locking #{{number}}.',
          },
        },
      },
    );

    await runScheduled(context);

    expect(commentMock).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Hello @{{user}}, locking #9.',
    }));
  });
});
