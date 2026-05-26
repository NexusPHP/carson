import type { Probot, ProbotOctokit } from 'probot';
import type { Logger } from 'pino';

export interface SchedulePayload {
  schedule: string;
  workflow: string;
}

export interface ScheduledContext {
  readonly octokit: InstanceType<typeof ProbotOctokit>;
  readonly log: Logger;
  readonly payload: SchedulePayload;
  repo: () => { owner: string; repo: string };
  config: <T>(file: string) => Promise<T | null>;
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

const buildContext = (
  octokit: InstanceType<typeof ProbotOctokit>,
  log: Logger,
  owner: string,
  repo: string,
  payload: SchedulePayload,
): ScheduledContext => ({
  octokit,
  log,
  payload,
  repo: () => ({ owner, repo }),
  config: async <T>(file: string): Promise<T | null> => {
    const result = await octokit.config.get({
      owner,
      repo,
      path: `.github/${file}`,
    });
    return result.config as T | null;
  },
});

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

  const context = buildContext(octokit, probot.log, owner, repo, payload);

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
