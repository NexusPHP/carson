import type { Probot, ProbotOctokit } from 'probot';
import type { Logger } from 'pino';

export interface SchedulePayload {
  schedule: string;
  workflow: string;
}

export interface ScheduledContext {
  octokit: InstanceType<typeof ProbotOctokit>;
  log: Logger;
  owner: string;
  repo: string;
  payload: SchedulePayload;
}

export type ScheduledHandler = (context: ScheduledContext) => Promise<void>;

export class ScheduledRegistrar {
  readonly #handlers: ScheduledHandler[] = [];

  public on(handler: ScheduledHandler): void {
    this.#handlers.push(handler);
  }

  public get handlers(): readonly ScheduledHandler[] {
    return this.#handlers;
  }
}

export interface ScheduledDispatchResult {
  failed: boolean;
}

export const dispatchScheduled = async (
  probot: Probot,
  registrar: ScheduledRegistrar,
  repository: string,
  payload: SchedulePayload,
): Promise<ScheduledDispatchResult> => {
  const slash = repository.indexOf('/');

  if (slash === -1) {
    throw new Error('GITHUB_REPOSITORY must be in owner/repo format');
  }

  const owner = repository.slice(0, slash);
  const repo = repository.slice(slash + 1);

  const appOctokit = await probot.auth();
  const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
  const octokit = await probot.auth(installation.id);

  const context: ScheduledContext = {
    octokit,
    log: probot.log,
    owner,
    repo,
    payload,
  };

  let failed = false;

  for (const handler of registrar.handlers) {
    try {
      await handler(context);
    } catch (error) {
      probot.log.error(error);
      failed = true;
    }
  }

  return { failed };
};
