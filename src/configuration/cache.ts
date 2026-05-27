import * as core from '@actions/core';
import { type CarsonConfig, CarsonConfigSchema } from './schema.js';
import type { Logger } from 'pino';
import type { ProbotOctokit } from 'probot';

const CONFIG_FILE = 'carson.yml';
const CONFIG_PATH = `.github/${CONFIG_FILE}`;

export interface ConfigLoadable {
  config: <T>(file: string) => Promise<T | null>;
  repo: () => { owner: string; repo: string };
  log: Logger;
}

export const createConfigLoadable = (
  octokit: InstanceType<typeof ProbotOctokit>,
  owner: string,
  repo: string,
  log: Logger,
): ConfigLoadable => ({
  config: async <T>(file: string): Promise<T | null> => {
    const result = await octokit.config.get({
      owner,
      repo,
      path: `.github/${file}`,
    });

    return result.config as T | null;
  },
  repo: () => ({ owner, repo }),
  log,
});

const cache = new Map<string, Promise<CarsonConfig | null>>();
let registeredIds: readonly string[] = [];

export const setRegisteredSubscribers = (ids: readonly string[]): void => {
  registeredIds = ids;
};

const fetchAndParse = async (context: ConfigLoadable): Promise<CarsonConfig | null> => {
  const raw = await context.config<Record<string, unknown>>(CONFIG_FILE);

  if (raw === null) {
    return null;
  }

  const parsed = CarsonConfigSchema.safeParse(raw);

  if (!parsed.success) {
    context.log.error({ err: parsed.error.format() }, `Invalid ${CONFIG_FILE}`);

    return null;
  }

  for (const id of parsed.data.subscribers) {
    if (!registeredIds.includes(id)) {
      const message = `${CONFIG_FILE} lists unknown subscriber "${id}"`;
      context.log.warn(message);
      core.warning(message, { file: CONFIG_PATH });
    }
  }

  return parsed.data;
};

export const loadConfig = async (context: ConfigLoadable): Promise<CarsonConfig | null> => {
  const { owner, repo } = context.repo();
  const key = `${owner}/${repo}`;
  let pending = cache.get(key);

  if (pending === undefined) {
    pending = fetchAndParse(context);
    cache.set(key, pending);
  }

  return await pending;
};

export const resetConfigCache = (): void => {
  cache.clear();
};
