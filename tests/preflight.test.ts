import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findMissingPermissions, formatMissingPermissionsError, runPreflight } from '../src/preflight.js';
import { type RequiredPermissions, Subscriber } from '../src/subscriber.js';
import { appIdentity } from '../src/app-identity.js';
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
}

describe('findMissingPermissions', () => {
  it('returns nothing when base + enabled requirements are all satisfied', () => {
    const enabled = [new StubSubscriber('s1', { issues: 'write' })];
    const installPerms = { contents: 'read' as const, issues: 'write' as const };
    const appPerms = installPerms;

    expect(findMissingPermissions(enabled, installPerms, appPerms)).toEqual([]);
  });

  it('reports the missing base contents permission when nothing is granted', () => {
    const missing = findMissingPermissions([], {}, {});

    expect(missing).toEqual([
      { subscriberId: '<base>', permission: 'contents', required: 'read', installGranted: undefined, appDeclared: undefined },
    ]);
  });

  it('reports a permission granted at a lower level than required, with the App declaration carried through', () => {
    const enabled = [new StubSubscriber('s1', { issues: 'write' })];
    const installPerms = { contents: 'read' as const, issues: 'read' as const };
    const appPerms = { contents: 'read' as const, issues: 'write' as const };

    expect(findMissingPermissions(enabled, installPerms, appPerms)).toEqual([
      { subscriberId: 's1', permission: 'issues', required: 'write', installGranted: 'read', appDeclared: 'write' },
    ]);
  });

  it('treats admin as sufficient for write or read', () => {
    const enabled = [new StubSubscriber('s1', { issues: 'write', pull_requests: 'read' })];
    const perms = { contents: 'admin' as const, issues: 'admin' as const, pull_requests: 'admin' as const };

    expect(findMissingPermissions(enabled, perms, perms)).toEqual([]);
  });

  it('aggregates missing entries across multiple subscribers and base', () => {
    const enabled = [
      new StubSubscriber('s1', { issues: 'write' }),
      new StubSubscriber('s2', { checks: 'write' }),
    ];
    const installPerms = { issues: 'read' as const };
    const appPerms = { issues: 'read' as const };

    expect(findMissingPermissions(enabled, installPerms, appPerms)).toEqual([
      { subscriberId: '<base>', permission: 'contents', required: 'read', installGranted: undefined, appDeclared: undefined },
      { subscriberId: 's1', permission: 'issues', required: 'write', installGranted: 'read', appDeclared: 'read' },
      { subscriberId: 's2', permission: 'checks', required: 'write', installGranted: undefined, appDeclared: undefined },
    ]);
  });
});

describe('formatMissingPermissionsError', () => {
  it('reports "Re-approve the installation" when the App already declares the permission', () => {
    const out = formatMissingPermissionsError(
      [{ subscriberId: 's1', permission: 'issues', required: 'write', installGranted: 'read', appDeclared: 'write' }],
      'https://github.com/apps/carson-acme',
      { name: 'Carson @ acme', slug: 'carson-acme' },
    );

    expect(out).toContain('Carson @ acme is missing required GitHub App permissions:');
    expect(out).toContain('  - issues (s1): required "write", App declares "write", install accepted "read". Re-approve the installation.');
    expect(out).toContain('App settings: https://github.com/apps/carson-acme');
  });

  it('reports "Update App settings, then re-approve" when the App does not declare the permission at the required level', () => {
    const out = formatMissingPermissionsError(
      [{ subscriberId: 's1', permission: 'checks', required: 'write', installGranted: undefined, appDeclared: undefined }],
      undefined,
      undefined,
    );

    expect(out).toContain('Carson is missing required GitHub App permissions:');
    expect(out).toContain('  - checks (s1): required "write", App declares nothing, install accepted nothing. Update App settings, then re-approve the installation.');
    expect(out).not.toContain('http');
  });

  it('reports "Update App settings, then re-approve" when the App declares a lower level than required', () => {
    const out = formatMissingPermissionsError(
      [{ subscriberId: 's1', permission: 'issues', required: 'write', installGranted: 'read', appDeclared: 'read' }],
      undefined,
      undefined,
    );

    expect(out).toContain('  - issues (s1): required "write", App declares "read", install accepted "read". Update App settings, then re-approve the installation.');
  });
});

interface AppDataStub {
  permissions?: Record<string, string> | undefined;
  html_url?: string | undefined;
  name?: string | undefined;
  slug?: string | undefined;
}

interface InstallationStub {
  permissions?: Record<string, string> | undefined;
}

interface HarnessOverrides {
  appData?: AppDataStub | null;
  installation?: InstallationStub;
  installFails?: boolean;
  config?: unknown;
}

const DEFAULT_PERMS: Record<string, string> = { contents: 'read', issues: 'write' };

const DEFAULT_APP_DATA: AppDataStub = {
  permissions: DEFAULT_PERMS,
  html_url: 'https://github.com/apps/test',
  name: 'Carson @ test',
  slug: 'carson-test',
};

const DEFAULT_INSTALLATION: InstallationStub = {
  permissions: DEFAULT_PERMS,
};

const makeProbot = (overrides: HarnessOverrides = {}): Probot => {
  const appData = overrides.appData === undefined ? DEFAULT_APP_DATA : overrides.appData;
  const installation = { id: 99, ...(overrides.installation ?? DEFAULT_INSTALLATION) };
  const getAuthenticated = vi.fn().mockResolvedValue({ data: appData });
  const getRepoInstallation = overrides.installFails === true
    ? vi.fn().mockRejectedValue(new Error('Not Found'))
    : vi.fn().mockResolvedValue({ data: installation });
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
    appIdentity.reset();
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
      appData: { ...DEFAULT_APP_DATA, permissions: { contents: 'read' } },
      installation: { permissions: { contents: 'read' } },
    });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(false);
    expect(setFailed).toHaveBeenCalledOnce();
    const message = setFailed.mock.calls[0]?.[0] as string;
    expect(message).toContain('Carson @ test is missing required GitHub App permissions:');
    expect(message).toContain('issues (s1): required "write", App declares nothing, install accepted nothing. Update App settings, then re-approve the installation.');
    expect(message).toContain('App settings: https://github.com/apps/test');
  });

  it('reports "Re-approve the installation" when the App declares the permission but the install has not accepted it', async () => {
    const probot = makeProbot({
      appData: { ...DEFAULT_APP_DATA, permissions: { contents: 'read', issues: 'write' } },
      installation: { permissions: { contents: 'read', issues: 'read' } },
    });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(false);
    const message = setFailed.mock.calls[0]?.[0] as string;
    expect(message).toContain('issues (s1): required "write", App declares "write", install accepted "read". Re-approve the installation.');
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

  it('falls back to the default name and slug when the App response omits them', async () => {
    const probot = makeProbot({
      appData: { ...DEFAULT_APP_DATA, name: undefined, slug: undefined },
    });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(true);
    expect(appIdentity.name).toBe('Carson');
  });

  it('treats a missing permissions field on the App or installation as no permissions', async () => {
    const probot = makeProbot({
      appData: { ...DEFAULT_APP_DATA, permissions: undefined },
      installation: { permissions: undefined },
    });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(false);
    const message = setFailed.mock.calls[0]?.[0] as string;
    expect(message).toContain('contents (<base>): required "read", App declares nothing, install accepted nothing. Update App settings, then re-approve the installation.');
    expect(message).toContain('issues (s1): required "write", App declares nothing, install accepted nothing. Update App settings, then re-approve the installation.');
  });

  it('fails when GITHUB_REPOSITORY is not in owner/repo format', async () => {
    const probot = makeProbot();
    const carson = new Carson([]);

    const ok = await runPreflight(probot, carson, 'not-a-slash-pair');

    expect(ok).toBe(false);
    expect(setFailed).toHaveBeenCalledWith('GITHUB_REPOSITORY must be in owner/repo format');
  });

  it('omits the App settings line when the App data has no html_url', async () => {
    const probot = makeProbot({
      appData: { ...DEFAULT_APP_DATA, html_url: undefined, permissions: { contents: 'read' } },
      installation: { permissions: { contents: 'read' } },
    });
    const carson = new Carson([new StubSubscriber('s1', { issues: 'write' })]);

    await runPreflight(probot, carson, 'acme/widgets');

    const message = setFailed.mock.calls[0]?.[0] as string;
    expect(message).not.toContain('App settings:');
    expect(message).not.toContain('http');
  });

  it('ignores subscribers that are bundled but not enabled in carson.yml', async () => {
    const probot = makeProbot({
      appData: { ...DEFAULT_APP_DATA, permissions: { contents: 'read', issues: 'read' } },
      installation: { permissions: { contents: 'read', issues: 'read' } },
      config: { version: 1, subscribers: ['s1'] },
    });
    const carson = new Carson([
      new StubSubscriber('s1', { issues: 'read' }),
      new StubSubscriber('s2', { actions: 'write' }),
    ]);
    const ok = await runPreflight(probot, carson, 'acme/widgets');

    expect(ok).toBe(true);
    expect(setFailed).not.toHaveBeenCalled();
  });
});
