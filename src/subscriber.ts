import { type ActionContext, type ActionName, type ActionRegistrar, type ActionRequests } from './actions.js';
import { type CarsonConfig, subscriberSettings } from './configuration/schema.js';
import { type ConfigLoadable, loadConfig } from './configuration/cache.js';
import { type FoundNotice, isNoticeResolved, queueNotice, reopenNotice, resolveNotice } from './github/notices.js';
import type { components } from '@octokit/openapi-types';
import type { Logger } from 'pino';
import type { MinimizeClassifier } from './github/comments.js';
import type { Probot } from 'probot';
import type { ScheduledRegistrar } from './scheduled.js';
import type { z } from 'zod';

export type PermissionLevel = 'read' | 'write' | 'admin';
export type PermissionKey = keyof NonNullable<components['schemas']['app-permissions']>;
export type RequiredPermissions = Readonly<Partial<Record<PermissionKey, PermissionLevel>>>;

type NoticeContext = Pick<ActionContext, 'octokit' | 'repo'>;

export interface EnabledSettings<T> {
  config: CarsonConfig;
  settings: T;
}

export abstract class Subscriber {
  public abstract readonly id: string;
  public abstract readonly description: string;
  public abstract readonly requiredPermissions: RequiredPermissions;

  #actions: ActionRegistrar | null = null;

  public register(_probot: Probot): void {}

  public registerScheduled(_registrar: ScheduledRegistrar): void {}

  public registerActions(_registrar: ActionRegistrar): void {}

  public bindActions(registrar: ActionRegistrar): void {
    this.#actions = registrar;
  }

  protected log(context: { log: Logger }): Logger {
    return context.log.child({ name: this.id });
  }

  /** Resolves to false when no router is bound, no enabled subscriber owns the action, or the owner declined it. */
  protected async dispatch<N extends ActionName>(
    name: N,
    context: ActionContext,
    request: ActionRequests[N],
  ): Promise<boolean> {
    if (this.#actions === null) {
      this.log(context).warn(`No action router bound, cannot dispatch "${name}"`);

      return false;
    }

    return await this.#actions.dispatch(name, context, request);
  }

  protected notice(context: NoticeContext, number: number, body: string): void {
    queueNotice(context.octokit, { ...context.repo(), number }, { id: this.id, body });
  }

  protected isNoticeResolved(found: FoundNotice): boolean {
    return isNoticeResolved(this.id, found);
  }

  protected async resolveNotice(context: NoticeContext, number: number, found: FoundNotice, classifier: MinimizeClassifier): Promise<void> {
    await resolveNotice(context.octokit, { ...context.repo(), number }, this.id, found, classifier);
  }

  protected async reopenNotice(context: NoticeContext, number: number, found: FoundNotice): Promise<void> {
    await reopenNotice(context.octokit, { ...context.repo(), number }, this.id, found);
  }

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
    context: ConfigLoadable,
    schema: z.ZodSchema<T>,
  ): Promise<EnabledSettings<T> | null> {
    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return null;
    }

    const settings = subscriberSettings(config, this.id, schema, this.log(context)) ?? ({} as T);

    return { config, settings };
  }
}
