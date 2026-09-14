import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import { type ScheduledContext, ScheduledRegistrar } from '../../src/scheduled.js';
import app from '../../src/app.js';
import { CachePrunerSubscriber } from '../../src/subscribers/cache-pruner.js';
import { generateKeyPairSync } from 'node:crypto';
import { logger } from '../../src/logger.js';
import nock from 'nock';
import { resetConfigCache } from '../../src/configuration/cache.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const API = 'https://api.github.com';
const INSTALLATION_ID = 12345;

interface CacheShape {
  id?: number;
  ref: string;
  key?: string;
  size_in_bytes?: number;
  created_at?: string;
  last_accessed_at?: string;
}

const cache = (shape: CacheShape): Record<string, unknown> => ({
  id: shape.id,
  ref: shape.ref,
  key: shape.key ?? `key-${shape.id ?? 0}`,
  version: 'v1',
  size_in_bytes: shape.size_in_bytes ?? 1_500_000,
  created_at: shape.created_at ?? '2026-01-01T00:00:00Z',
  last_accessed_at: shape.last_accessed_at ?? '2026-01-01T00:00:00Z',
});

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

const mockList = (ref: string, caches: CacheShape[]): nock.Scope =>
  nock(API)
    .get('/repos/acme/widgets/actions/caches')
    .query({ ref, per_page: '100' })
    .reply(200, { total_count: caches.length, actions_caches: caches.map(cache) });

const mockDelete = (id: number, status = 204): nock.Scope =>
  nock(API).delete(`/repos/acme/widgets/actions/caches/${id}`).reply(status);

const prClosedPayload = (number = 42): Record<string, unknown> => ({
  action: 'closed',
  installation: { id: INSTALLATION_ID },
  pull_request: { number, merged: true, user: { login: 'octocat', type: 'User' }, labels: [] },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: 'User' },
});

const deletePayload = (refType: 'branch' | 'tag', ref = 'feature/x'): Record<string, unknown> => ({
  ref,
  ref_type: refType,
  installation: { id: INSTALLATION_ID },
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: 'User' },
});

const buildConfig = (settings: string[] = []): string => [
  'version: 1',
  'subscribers:',
  '  - cache-pruner',
  ...(settings.length > 0 ? ['settings:', '  cache-pruner:', ...settings.map((s) => `    ${s}`)] : []),
  '',
].join('\n');

describe('cache-pruner subscriber (via app)', () => {
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

  it('does nothing when cache-pruner is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({ id: 'evt-not-enabled', name: 'pull_request', payload: prClosedPayload() as never });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('deletes the caches of a closed pull request', async () => {
    mockInstallationToken();
    mockConfig(buildConfig());
    mockList('refs/pull/42/merge', [{ id: 101, ref: 'refs/pull/42/merge' }, { id: 102, ref: 'refs/pull/42/merge' }]);
    const first = mockDelete(101);
    const second = mockDelete(102);

    await probot.receive({ id: 'evt-closed', name: 'pull_request', payload: prClosedPayload() as never });

    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips closed pull requests when on_close is false', async () => {
    mockInstallationToken();
    mockConfig(buildConfig(['on_close: false']));

    await probot.receive({ id: 'evt-closed-off', name: 'pull_request', payload: prClosedPayload() as never });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('deletes the caches of a deleted branch', async () => {
    mockInstallationToken();
    mockConfig(buildConfig());
    mockList('refs/heads/feature/x', [{ id: 201, ref: 'refs/heads/feature/x' }]);
    const deleteScope = mockDelete(201);

    await probot.receive({ id: 'evt-branch-deleted', name: 'delete', payload: deletePayload('branch') as never });

    expect(deleteScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores deleted tags', async () => {
    await probot.receive({ id: 'evt-tag-deleted', name: 'delete', payload: deletePayload('tag', 'v1.0.0') as never });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips deleted branches when on_branch_delete is false', async () => {
    mockInstallationToken();
    mockConfig(buildConfig(['on_branch_delete: false']));

    await probot.receive({ id: 'evt-branch-off', name: 'delete', payload: deletePayload('branch') as never });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('continues past a cache that fails to delete', async () => {
    mockInstallationToken();
    mockConfig(buildConfig());
    mockList('refs/pull/42/merge', [{ id: 101, ref: 'refs/pull/42/merge' }, { id: 102, ref: 'refs/pull/42/merge' }]);
    mockDelete(101, 500);
    const second = mockDelete(102);

    await probot.receive({ id: 'evt-delete-fails', name: 'pull_request', payload: prClosedPayload() as never });

    expect(second.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores a listed cache that is missing a field', async () => {
    mockInstallationToken();
    mockConfig(buildConfig());
    mockList('refs/pull/42/merge', [{ ref: 'refs/pull/42/merge' }, { id: 102, ref: 'refs/pull/42/merge' }]);
    const deleteScope = mockDelete(102);

    await probot.receive({ id: 'evt-partial-cache', name: 'pull_request', payload: prClosedPayload() as never });

    expect(deleteScope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await probot.receive({ id: 'evt-no-config', name: 'pull_request', payload: prClosedPayload() as never });

    expect(nock.pendingMocks()).toEqual([]);
  });
});

const NOW = new Date('2026-03-01T00:00:00Z').getTime();
const DAYS_AGO = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

interface Harness {
  context: ScheduledContext;
  deleteMock: ReturnType<typeof vi.fn>;
  paginateMock: ReturnType<typeof vi.fn>;
  pullGetMock: ReturnType<typeof vi.fn>;
  repoGetMock: ReturnType<typeof vi.fn>;
}

const makeStubLog = (): Record<string, unknown> => {
  const log: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log['child'] = vi.fn().mockReturnValue(log);

  return log;
};

const makeHarness = (caches: CacheShape[], config: unknown, closedPrs: number[] = []): Harness => {
  const deleteMock = vi.fn().mockResolvedValue({});
  const paginateMock = vi.fn().mockResolvedValue(caches.map(cache));
  const pullGetMock = vi.fn().mockImplementation(async ({ pull_number }: { pull_number: number }) =>
    await Promise.resolve({ data: { state: closedPrs.includes(pull_number) ? 'closed' : 'open' } }),
  );
  const repoGetMock = vi.fn().mockResolvedValue({ data: { default_branch: 'main' } });

  const context: ScheduledContext = {
    octokit: {
      paginate: paginateMock,
      rest: {
        actions: { getActionsCacheList: 'list-fn', deleteActionsCacheById: deleteMock },
        pulls: { get: pullGetMock },
        repos: { get: repoGetMock },
      },
    } as never,
    log: makeStubLog() as never,
    payload: { schedule: '0 * * * *', workflow: '.github/workflows/cron.yml' },
    repo: () => ({ owner: 'acme', repo: 'widgets' }),
    config: vi.fn().mockResolvedValue(config),
  };

  return { context, deleteMock, paginateMock, pullGetMock, repoGetMock };
};

const runScheduled = async (context: ScheduledContext): Promise<void> => {
  const subscriber = new CachePrunerSubscriber();
  const registrar = new ScheduledRegistrar();
  subscriber.registerScheduled(registrar);

  for (const handler of registrar.handlers) {
    await handler(context);
  }
};

const deletedIds = (deleteMock: ReturnType<typeof vi.fn>): number[] =>
  deleteMock.mock.calls.map((call: unknown[]) => (call[0] as { cache_id: number }).cache_id).sort((a, b) => a - b);

const enabledConfig = (settings: Record<string, unknown> = {}): unknown => ({
  version: 1,
  subscribers: ['cache-pruner'],
  settings: { 'cache-pruner': settings },
});

describe('cache-pruner subscriber (scheduled sweep)', () => {
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

  const MIXED: CacheShape[] = [
    { id: 1, ref: 'refs/pull/1/merge' },
    { id: 2, ref: 'refs/pull/1/merge' },
    { id: 3, ref: 'refs/pull/2/merge' },
    { id: 4, ref: 'refs/heads/feature/x' },
  ];

  it('does nothing when cache-pruner is not enabled', async () => {
    const { context, paginateMock } = makeHarness(MIXED, { version: 1, subscribers: ['welcome'] });

    await runScheduled(context);

    expect(paginateMock).not.toHaveBeenCalled();
  });

  it('deletes the caches of closed pull requests by default', async () => {
    const { context, deleteMock, pullGetMock } = makeHarness(MIXED, enabledConfig(), [1]);

    await runScheduled(context);

    expect(deletedIds(deleteMock)).toEqual([1, 2]);
    expect(pullGetMock).toHaveBeenCalledTimes(2);
  });

  it('deletes every pull request cache when sweep_pull_requests is all', async () => {
    const { context, deleteMock, pullGetMock } = makeHarness(MIXED, enabledConfig({ sweep_pull_requests: 'all' }));

    await runScheduled(context);

    expect(deletedIds(deleteMock)).toEqual([1, 2, 3]);
    expect(pullGetMock).not.toHaveBeenCalled();
  });

  it('skips the listing when sweep_pull_requests is none and no age limit is set', async () => {
    const { context, paginateMock } = makeHarness(MIXED, enabledConfig({ sweep_pull_requests: 'none' }));

    await runScheduled(context);

    expect(paginateMock).not.toHaveBeenCalled();
  });

  it('deletes idle branch caches past max_idle_days, sparing protected refs', async () => {
    const caches: CacheShape[] = [
      { id: 10, ref: 'refs/heads/feature/x', last_accessed_at: DAYS_AGO(5) },
      { id: 11, ref: 'refs/heads/feature/y', last_accessed_at: DAYS_AGO(1) },
      { id: 12, ref: 'refs/heads/main', last_accessed_at: DAYS_AGO(5) },
      { id: 13, ref: 'refs/heads/release', last_accessed_at: DAYS_AGO(5) },
      { id: 14, ref: 'refs/pull/7/merge', last_accessed_at: DAYS_AGO(5) },
    ];
    const { context, deleteMock, pullGetMock, repoGetMock } = makeHarness(caches, enabledConfig({
      sweep_pull_requests: 'none',
      max_idle_days: 2,
      protected_refs: ['refs/heads/release'],
    }));

    await runScheduled(context);

    expect(deletedIds(deleteMock)).toEqual([10]);
    expect(pullGetMock).not.toHaveBeenCalled();
    expect(repoGetMock).toHaveBeenCalledTimes(1);
  });

  it('deletes branch caches created before max_age_days even when recently accessed', async () => {
    const caches: CacheShape[] = [
      { id: 20, ref: 'refs/heads/feature/x', created_at: DAYS_AGO(10), last_accessed_at: DAYS_AGO(0) },
      { id: 21, ref: 'refs/heads/feature/y', created_at: DAYS_AGO(1), last_accessed_at: DAYS_AGO(0) },
    ];
    const { context, deleteMock } = makeHarness(caches, enabledConfig({ sweep_pull_requests: 'none', max_age_days: 7 }));

    await runScheduled(context);

    expect(deletedIds(deleteMock)).toEqual([20]);
  });

  it('reports zero deletions on an empty cache list', async () => {
    const { context, deleteMock, pullGetMock } = makeHarness([], enabledConfig());

    await runScheduled(context);

    expect(deleteMock).not.toHaveBeenCalled();
    expect(pullGetMock).not.toHaveBeenCalled();
  });
});
