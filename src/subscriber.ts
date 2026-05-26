import type { Context, Probot } from 'probot';
import type { CarsonConfig } from './configuration/schema.js';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { loadConfig } from './configuration/cache.js';
import type { ScheduledRegistrar } from './scheduled.js';

export abstract class Subscriber {
  public abstract readonly id: string;
  public abstract readonly description: string;

  public abstract register(probot: Probot): void;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public registerScheduled(_registrar: ScheduledRegistrar): void {}

  protected async loadEnabledConfig<E extends EmitterWebhookEventName>(
    context: Context<E>,
  ): Promise<CarsonConfig | null> {
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
