import * as core from '@actions/core';
import { type AppIdentity, setAppIdentity } from './app-identity.js';
import { type ConfigLoadable, loadConfig } from './configuration/cache.js';
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
  granted: PermissionLevel | undefined;
}

const isSufficient = (granted: PermissionLevel | undefined, required: PermissionLevel): boolean =>
  granted !== undefined && LEVEL_RANK[granted] >= LEVEL_RANK[required];

const collectMissing = (
  subscriberId: string,
  required: RequiredPermissions,
  granted: Readonly<Record<string, PermissionLevel>>,
): MissingPermission[] =>
  Object.entries(required)
    .filter(([perm, level]) => !isSufficient(granted[perm], level))
    .map(([perm, level]) => ({
      subscriberId,
      permission: perm,
      required: level,
      granted: granted[perm],
    }));

export const findMissingPermissions = (
  enabled: readonly Pick<Subscriber, 'id' | 'requiredPermissions'>[],
  granted: Readonly<Record<string, PermissionLevel>>,
): MissingPermission[] => [
  ...collectMissing('<base>', BASE_PERMISSIONS, granted),
  ...enabled.flatMap((s) => collectMissing(s.id, s.requiredPermissions, granted)),
];

export const formatMissingPermissionsError = (
  missing: readonly MissingPermission[],
  appHtmlUrl: string | undefined,
  app: AppIdentity | undefined,
): string => {
  const header = `${app?.name ?? 'Carson'} is missing required GitHub App permissions:`;
  const body = missing.map((m) => {
    const grantedText = m.granted === undefined ? 'not granted' : `granted "${m.granted}"`;
    return `  - ${m.permission}: required "${m.required}", ${grantedText} (${m.subscriberId})`;
  });
  const footer = appHtmlUrl === undefined
    ? 'Update permissions in your GitHub App settings.'
    : `Update permissions in your GitHub App settings: ${appHtmlUrl}`;

  return [header, ...body, footer].join('\n');
};

export const runPreflight = async (
  probot: Probot,
  carson: Carson,
  repository: string,
): Promise<boolean> => {
  const slash = repository.indexOf('/');

  if (slash === -1) {
    core.setFailed('GITHUB_REPOSITORY must be in owner/repo format');
    return false;
  }

  const owner = repository.slice(0, slash);
  const repo = repository.slice(slash + 1);
  const appOctokit = await probot.auth();
  const { data: app } = await appOctokit.rest.apps.getAuthenticated();

  if (app === null) {
    probot.log.warn('preflight: apps.getAuthenticated returned no app, skipping');
    return true;
  }

  const identity: AppIdentity = {
    name: app.name ?? 'Carson',
    slug: app.slug ?? 'carson',
    id: app.id,
  };
  setAppIdentity(identity);

  let installationId: number;

  try {
    const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
    installationId = installation.id;
  } catch (error) {
    probot.log.warn({ err: error }, 'preflight: could not resolve installation, skipping');
    return true;
  }

  const installationOctokit = await probot.auth(installationId);
  const loadable: ConfigLoadable = {
    config: async <T>(file: string): Promise<T | null> => {
      const result = await installationOctokit.config.get({
        owner,
        repo,
        path: `.github/${file}`,
      });
      return result.config as T | null;
    },
    repo: () => ({ owner, repo }),
    log: probot.log,
  };
  const config = await loadConfig(loadable);

  if (config === null) {
    return true;
  }

  const enabled = carson.subscribers.filter((s) => config.subscribers.includes(s.id));
  const granted = (app.permissions ?? {}) as Readonly<Record<string, PermissionLevel>>;
  const missing = findMissingPermissions(enabled, granted);

  if (missing.length > 0) {
    core.setFailed(formatMissingPermissionsError(missing, app.html_url, identity));
    return false;
  }

  return true;
};
