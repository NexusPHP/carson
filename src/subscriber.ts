import { type ConfigLoadable, loadConfig } from './configuration/cache.js';
import type { CarsonConfig } from './configuration/schema.js';
import type { Probot } from 'probot';
import type { ScheduledRegistrar } from './scheduled.js';

export type PermissionLevel = 'read' | 'write' | 'admin';
export type RequiredPermissions = Readonly<Record<string, PermissionLevel>>;

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
}
