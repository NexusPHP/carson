import * as core from '@actions/core';
import { type AppIdentity, setAppIdentity } from './app-identity.js';
import { createConfigLoadable, loadConfig } from './configuration/cache.js';
import { INVALID_REPOSITORY_MESSAGE, parseRepository } from './github/repository.js';
import { type PermissionLevel, type RequiredPermissions, type Subscriber } from './subscriber.js';
import type { Carson } from './carson.js';
import type { Probot } from 'probot';

// Every subscriber loads .github/carson.yml via the contents API.
const BASE_PERMISSIONS: RequiredPermissions = { contents: 'read' };

const LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = {
  read: 1,
  write: 2,
  admin: 3,
};

export interface MissingPermission {
  subscriberId: string;
  permission: string;
  required: PermissionLevel;
  installGranted: PermissionLevel | undefined;
  appDeclared: PermissionLevel | undefined;
}

const isSufficient = (granted: PermissionLevel | undefined, required: PermissionLevel): boolean =>
  granted !== undefined && LEVEL_RANK[granted] >= LEVEL_RANK[required];

const collectMissing = (
  subscriberId: string,
  required: RequiredPermissions,
  installPermissions: Readonly<Record<string, PermissionLevel>>,
  appPermissions: Readonly<Record<string, PermissionLevel>>,
): MissingPermission[] =>
  Object.entries(required)
    .filter(([perm, level]) => !isSufficient(installPermissions[perm], level))
    .map(([perm, level]) => ({
      subscriberId,
      permission: perm,
      required: level,
      installGranted: installPermissions[perm],
      appDeclared: appPermissions[perm],
    }));

export const findMissingPermissions = (
  enabled: readonly Pick<Subscriber, 'id' | 'requiredPermissions'>[],
  installPermissions: Readonly<Record<string, PermissionLevel>>,
  appPermissions: Readonly<Record<string, PermissionLevel>>,
): MissingPermission[] => [
  ...collectMissing('<base>', BASE_PERMISSIONS, installPermissions, appPermissions),
  ...enabled.flatMap((s) => collectMissing(s.id, s.requiredPermissions, installPermissions, appPermissions)),
];

const describeLevel = (level: PermissionLevel | undefined): string =>
  level === undefined ? 'nothing' : `"${level}"`;

const remediationFor = (m: MissingPermission): string =>
  m.appDeclared !== undefined && LEVEL_RANK[m.appDeclared] >= LEVEL_RANK[m.required]
    ? 'Re-approve the installation'
    : 'Update App settings, then re-approve the installation';

export const formatMissingPermissionsError = (
  missing: readonly MissingPermission[],
  appHtmlUrl: string | undefined,
  app: AppIdentity | undefined,
): string => {
  const header = `${app?.name ?? 'Carson'} is missing required GitHub App permissions:`;
  const body = missing.map((m) => {
    const declared = describeLevel(m.appDeclared);
    const accepted = describeLevel(m.installGranted);

    return `  - ${m.permission} (${m.subscriberId}): required "${m.required}", App declares ${declared}, install accepted ${accepted}. ${remediationFor(m)}.`;
  });
  const lines = [header, ...body];

  if (appHtmlUrl !== undefined) {
    lines.push(`App settings: ${appHtmlUrl}`);
  }

  return lines.join('\n');
};

export const runPreflight = async (
  probot: Probot,
  carson: Carson,
  repository: string,
): Promise<boolean> => {
  const parsed = parseRepository(repository);

  if (parsed === null) {
    core.setFailed(INVALID_REPOSITORY_MESSAGE);
    return false;
  }

  const { owner, repo } = parsed;
  const appOctokit = await probot.auth();
  const { data: app } = await appOctokit.rest.apps.getAuthenticated();

  if (app === null) {
    probot.log.warn('preflight: apps.getAuthenticated returned no app, skipping');
    return true;
  }

  const identity: AppIdentity = {
    name: app.name ?? 'Carson',
    slug: app.slug ?? 'carson',
  };
  setAppIdentity(identity);

  let installationId: number;
  let installationPermissions: Readonly<Record<string, PermissionLevel>>;

  try {
    const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
    installationId = installation.id;
    installationPermissions = (installation.permissions ?? {}) as Readonly<Record<string, PermissionLevel>>;
  } catch (error) {
    probot.log.warn({ err: error }, 'preflight: could not resolve installation, skipping');
    return true;
  }

  const installationOctokit = await probot.auth(installationId);
  const loadable = createConfigLoadable(installationOctokit, owner, repo, probot.log);
  const config = await loadConfig(loadable, carson.knownIds);

  if (config === null) {
    return true;
  }

  const appPermissions = (app.permissions ?? {}) as Readonly<Record<string, PermissionLevel>>;
  const missing = carson.missingPermissions(installationPermissions, appPermissions, config.subscribers);

  if (missing.length > 0) {
    core.setFailed(formatMissingPermissionsError(missing, app.html_url, identity));
    return false;
  }

  return true;
};
