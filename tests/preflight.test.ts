import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findMissingPermissions, formatMissingPermissionsError, runPreflight } from '../src/preflight.js';
import { type RequiredPermissions, Subscriber } from '../src/subscriber.js';
import { Carson } from '../src/carson.js';
import type { Probot } from 'probot';
import { resetConfigCache } from '../src/configuration/cache.js';

class StubSubscriber extends Subscriber {
  public constructor(
    public readonly id: string,
    public readonly requiredPermissions: RequiredPermissions,
  ) {
    super();
  }

  public readonly description = 'stub for preflight tests';
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public register(): void {}
}

describe('findMissingPermissions', () => {
  it('returns nothing when base + enabled requirements are all satisfied', () => {
    const enabled = [new StubSubscriber('s1', { issues: 'write' })];
    const granted = { contents: 'read' as const, issues: 'write' as const };

    expect(findMissingPermissions(enabled, granted)).toEqual([]);
  });

  it('reports the missing base contents permission when nothing is granted', () => {
    const missing = findMissingPermissions([], {});

    expect(missing).toEqual([
      { subscriberId: '<base>', permission: 'contents', required: 'read', granted: undefined },
    ]);
  });

  it('reports a permission granted at a lower level than required', () => {
    const enabled = [new StubSubscriber('s1', { issues: 'write' })];
    const granted = { contents: 'read' as const, issues: 'read' as const };

    expect(findMissingPermissions(enabled, granted)).toEqual([
      { subscriberId: 's1', permission: 'issues', required: 'write', granted: 'read' },
    ]);
  });

  it('treats admin as sufficient for write or read', () => {
    const enabled = [new StubSubscriber('s1', { issues: 'write', pull_requests: 'read' })];
    const granted = { contents: 'admin' as const, issues: 'admin' as const, pull_requests: 'admin' as const };

    expect(findMissingPermissions(enabled, granted)).toEqual([]);
  });

  it('aggregates missing entries across multiple subscribers and base', () => {
    const enabled = [
      new StubSubscriber('s1', { issues: 'write' }),
      new StubSubscriber('s2', { checks: 'write' }),
    ];
    const granted = { issues: 'read' as const };

    expect(findMissingPermissions(enabled, granted)).toEqual([
      { subscriberId: '<base>', permission: 'contents', required: 'read', granted: undefined },
      { subscriberId: 's1', permission: 'issues', required: 'write', granted: 'read' },
      { subscriberId: 's2', permission: 'checks', required: 'write', granted: undefined },
    ]);
  });
});

describe('formatMissingPermissionsError', () => {
  it('includes the App html_url when provided', () => {
    const out = formatMissingPermissionsError(
      [{ subscriberId: 's1', permission: 'issues', required: 'write', granted: 'read' }],
      'https://github.com/apps/carson-acme',
    );

    expect(out).toContain('Carson is missing required GitHub App permissions:');
    expect(out).toContain('  - issues: required "write", granted "read" (s1)');
    expect(out).toContain('Update permissions in your GitHub App settings: https://github.com/apps/carson-acme');
  });

  it('falls back to a generic settings message when html_url is undefined', () => {
    const out = formatMissingPermissionsError(
      [{ subscriberId: 's1', permission: 'checks', required: 'write', granted: undefined }],
      undefined,
    );

    expect(out).toContain('  - checks: required "write", not granted (s1)');
    expect(out).toContain('Update permissions in your GitHub App settings.');
    expect(out).not.toContain('http');
  });
});

interface HarnessOverrides {
  appData?: { permissions?: Record<string, string>; html_url?: string } | null;
  installFails?: boolean;
  config?: unknown;
}

const makeProbot = (overrides: HarnessOverrides = {}): Probot => {
  const appData = overrides.appData === undefined
    ? { permissions: { contents: 'read', issues: 'write' }, html_url: 'https://github.com/apps/test' }
    : overrides.appData;
  const getAuthenticated = vi.fn().mockResolvedValue({ data: appData });
  const getRepoInstallation = overrides.installFails === true
    ? vi.fn().mockRejectedValue(new Error('Not Found'))
    : vi.fn().mockResolvedValue({ data: { id: 99 } });
  const configGet = vi.fn().mockResolvedValue({
    config: 'config' in overrides ? overrides.config : { version: 1, subscribers: ['s1'] },
    files: [],
  });

  const appOctokit = { rest: { apps: { getAuthenticated, getRepoInstallation } } };
  const installationOctokit = { config: { get: configGet } };
  const auth = vi.fn(async (id?: number) => {
    await Promise.resolve();
    return id === undefined ? appOctokit : installationOctokit;
  });

  return {
    auth,
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as Probot;
};

describe('runPreflight', () => {
  const setFailed = vi.mocked(core.setFailed);

  beforeEach(() => {
    resetConfigCache();
    setFailed.mockClear();
  });

  it('returns true when every enabled subscriber has its permissions satisfied', async () => {
    const probot = makeProbot();
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(true);
    expect(setFailed).not.toHaveBeenCalled();
  });

  it('fails and reports each missing permission when the App is under-permissioned', async () => {
    const probot = makeProbot({
      appData: { permissions: { contents: 'read' }, html_url: 'https://github.com/apps/test' },
    });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(false);
    expect(setFailed).toHaveBeenCalledOnce();
    const message = setFailed.mock.calls[0]?.[0] as string;
    expect(message).toContain('issues: required "write", not granted (s1)');
    expect(message).toContain('https://github.com/apps/test');
  });

  it('returns true and skips the check when the App is not installed on the repo', async () => {
    const probot = makeProbot({ installFails: true });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(true);
    expect(setFailed).not.toHaveBeenCalled();
  });

  it('returns true when carson.yml is missing (no subscribers to preflight)', async () => {
    const probot = makeProbot({ config: null });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(true);
    expect(setFailed).not.toHaveBeenCalled();
  });

  it('returns true when apps.getAuthenticated returns no app', async () => {
    const probot = makeProbot({ appData: null });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(true);
    expect(setFailed).not.toHaveBeenCalled();
  });

  it('treats a missing permissions field on the App as no permissions', async () => {
    const probot = makeProbot({ appData: { html_url: 'https://github.com/apps/test' } });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(false);
    const message = setFailed.mock.calls[0]?.[0] as string;
    expect(message).toContain('contents: required "read", not granted (<base>)');
    expect(message).toContain('issues: required "write", not granted (s1)');
  });

  it('fails when GITHUB_REPOSITORY is not in owner/repo format', async () => {
    const probot = makeProbot();
    const carson = new Carson([]);

    const ok = await runPreflight(probot, carson, 'not-a-slash-pair');

    expect(ok).toBe(false);
    expect(setFailed).toHaveBeenCalledWith('GITHUB_REPOSITORY must be in owner/repo format');
  });

  it('omits the html_url line when the App data has no html_url', async () => {
    const probot = makeProbot({
      appData: { permissions: { contents: 'read' } },
    });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    await runPreflight(probot, carson, 'acme/widgets');

    const message = setFailed.mock.calls[0]?.[0] as string;
    expect(message).toContain('Update permissions in your GitHub App settings.');
    expect(message).not.toContain('http');
  });

  it('ignores subscribers that are bundled but not enabled in carson.yml', async () => {
    const probot = makeProbot({
      appData: { permissions: { contents: 'read', issues: 'read' }, html_url: 'https://github.com/apps/test' },
      config: { version: 1, subscribers: ['s1'] },
    });
    const carson = new Carson([
      new StubSubscriber('s1', { issues: 'read' }),
      new StubSubscriber('s2', { admin_huge: 'write' }),
    ]);
    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(true);
    expect(setFailed).not.toHaveBeenCalled();
  });
});
