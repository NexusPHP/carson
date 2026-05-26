import { z } from 'zod';

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
): T | undefined => {
  const raw = config.settings?.[subscriberId];

  if (raw === undefined) {
    return undefined;
  }

  return schema.parse(raw);
};
