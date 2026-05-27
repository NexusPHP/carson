import * as core from '@actions/core';
import type { Logger } from 'pino';
import { z } from 'zod';

const CONFIG_PATH = '.github/carson.yml';

export const CarsonConfigSchema = z.object({
  version: z.literal(1),
  subscribers: z.array(z.string()),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type CarsonConfig = z.infer<typeof CarsonConfigSchema>;

export const subscriberSettings = <T>(
  config: CarsonConfig,
  subscriberId: string,
  schema: z.ZodSchema<T>,
  log?: Logger,
): T | undefined => {
  const raw = config.settings?.[subscriberId];

  if (raw === undefined) {
    return undefined;
  }

  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    const message = `Invalid settings for subscriber "${subscriberId}" in carson.yml. Falling back to defaults.`;

    if (log !== undefined) {
      log.warn({ issues: parsed.error.issues }, message);
    }

    core.warning(message, { file: CONFIG_PATH });

    return undefined;
  }

  return parsed.data;
};
