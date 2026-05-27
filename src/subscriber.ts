import { type CarsonConfig, subscriberSettings } from './configuration/schema.js';
import { type ConfigLoadable, loadConfig } from './configuration/cache.js';
import type { Probot } from 'probot';
import type { ScheduledRegistrar } from './scheduled.js';
import type { z } from 'zod';

export type PermissionLevel = 'read' | 'write' | 'admin';
export type RequiredPermissions = Readonly<Record<string, PermissionLevel>>;

export interface EnabledSettings<T> {
  config: CarsonConfig;
  settings: T;
}

export abstract class Subscriber {
  public abstract readonly id: string;
  public abstract readonly description: string;
  public abstract readonly requiredPermissions: RequiredPermissions;

  public register(_probot: Probot): void {}

  public registerScheduled(_registrar: ScheduledRegistrar): void {}

  protected async loadEnabledConfig(context: ConfigLoadable): Promise<CarsonConfig | null> {
    const config = await loadConfig(context);

    if (config === null) {
      return null;
    }

    if (!config.subscribers.includes(this.id)) {
      return null;
    }

    return config;
  }

  protected async loadEnabledSettings<T>(
    context: ConfigLoadable & { isBot?: boolean },
    schema: z.ZodSchema<T>,
  ): Promise<EnabledSettings<T> | null> {
    if (context.isBot === true) {
      return null;
    }

    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return null;
    }

    const settings = subscriberSettings(config, this.id, schema, context.log) ?? ({} as T);

    return { config, settings };
  }
}
