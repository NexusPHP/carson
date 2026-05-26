import { type CarsonConfig, CarsonConfigSchema } from './schema.js';
import type { Context } from 'probot';
import type { EmitterWebhookEventName } from '@octokit/webhooks';

const CONFIG_FILE = 'carson.yml';

const cache = new Map<string, Promise<CarsonConfig | null>>();
let registeredIds: readonly string[] = [];

export const setRegisteredSubscribers = (ids: readonly string[]): void => {
  registeredIds = ids;
};

const fetchAndParse = async <E extends EmitterWebhookEventName>(context: Context<E>): Promise<CarsonConfig | null> => {
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
      context.log.warn(`${CONFIG_FILE} lists unknown subscriber "${id}"`);
    }
  }

  return parsed.data;
};

export const loadConfig = async <E extends EmitterWebhookEventName>(context: Context<E>): Promise<CarsonConfig | null> => {
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
