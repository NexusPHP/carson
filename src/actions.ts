import { logger } from './logger.js';
import type { ScheduledContext } from './scheduled.js';

export type ActionContext = Omit<ScheduledContext, 'payload'>;

export interface ActionRequests {
  lock: { number: number };
}

export type ActionName = keyof ActionRequests;

export type ActionHandler<N extends ActionName> = (
  context: ActionContext,
  request: ActionRequests[N],
) => Promise<void>;

interface Registration<N extends ActionName> {
  subscriberId: string;
  handler: ActionHandler<N>;
}

/** Routes cross-subscriber actions to the single subscriber that owns each one. */
export class ActionRegistrar {
  readonly #handlers = new Map<ActionName, Registration<ActionName>>();

  // The same owner may re-register (run() is invoked per Probot instance).
  public on<N extends ActionName>(name: N, subscriberId: string, handler: ActionHandler<N>): void {
    const existing = this.#handlers.get(name);

    if (existing !== undefined && existing.subscriberId !== subscriberId) {
      throw new Error(`Action "${name}" is already handled by "${existing.subscriberId}"`);
    }

    this.#handlers.set(name, { subscriberId, handler: handler as ActionHandler<ActionName> });
  }

  public has(name: ActionName): boolean {
    return this.#handlers.has(name);
  }

  /** Resolves to false, after a warning, when no enabled subscriber handles the action. */
  public async dispatch<N extends ActionName>(
    name: N,
    context: ActionContext,
    request: ActionRequests[N],
  ): Promise<boolean> {
    const registration = this.#handlers.get(name);

    if (registration === undefined) {
      logger.for('carson').warn(`No enabled subscriber handles the "${name}" action, skipping`);

      return false;
    }

    await registration.handler(context, request);

    return true;
  }
}
