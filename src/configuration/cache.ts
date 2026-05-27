import * as core from '@actions/core';
import { type CarsonConfig, CarsonConfigSchema } from './schema.js';
import { logger } from '../logger.js';
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

const fetchAndParse = async (
  context: ConfigLoadable,
  knownIds: readonly string[] | undefined,
): Promise<CarsonConfig | null> => {
  const raw = await context.config<Record<string, unknown>>(CONFIG_FILE);

  if (raw === null) {
    return null;
  }

  const parsed = CarsonConfigSchema.safeParse(raw);
  const log = logger.for('config');

  if (!parsed.success) {
    log.error({ err: parsed.error.format() }, `Invalid ${CONFIG_FILE}`);

    return null;
  }

  if (knownIds !== undefined) {
    for (const id of parsed.data.subscribers) {
      if (!knownIds.includes(id)) {
        const message = `Unknown subscriber "${id}" listed in ${CONFIG_FILE}`;
        log.warn(message);
        core.warning(message, { file: CONFIG_PATH });
      }
    }
  }

  return parsed.data;
};

export const loadConfig = async (
  context: ConfigLoadable,
  knownIds?: readonly string[],
): Promise<CarsonConfig | null> => {
  const { owner, repo } = context.repo();
  const key = `${owner}/${repo}`;
  let pending = cache.get(key);

  if (pending === undefined) {
    pending = fetchAndParse(context, knownIds);
    cache.set(key, pending);
  }

  return await pending;
};

export const resetConfigCache = (): void => {
  cache.clear();
};
