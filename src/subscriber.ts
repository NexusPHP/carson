import type { Context, Probot } from 'probot';
import type { CarsonConfig } from './configuration/schema.js';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { loadConfig } from './configuration/cache.js';

export abstract class Subscriber {
  public abstract readonly id: string;
  public abstract readonly description: string;

  public abstract register(probot: Probot): void;

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
