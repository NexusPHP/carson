import type { ApplicationFunction, Probot } from 'probot';
import { findMissingPermissions, type MissingPermission } from './preflight.js';
import type { PermissionLevel, Subscriber } from './subscriber.js';
import { ScheduledRegistrar } from './scheduled.js';

export class Carson {
  public static readonly DISPLAY_NAME: string = 'Carson';
  readonly #subscribers: readonly Subscriber[];
  readonly #scheduled = new ScheduledRegistrar();

  public constructor(subscribers: readonly Subscriber[]) {
    this.#subscribers = subscribers;
  }

  public run(probot: Probot): void {
    probot.log.info(`${Carson.DISPLAY_NAME} starting`);

    for (const subscriber of this.#subscribers) {
      probot.log.info(`Registering subscriber: ${subscriber.id}`);
      subscriber.register(probot);
      subscriber.registerScheduled(this.#scheduled);
    }
  }

  public get app(): ApplicationFunction {
    return (probot: Probot): void => {
      this.run(probot);
    };
  }

  public get scheduled(): ScheduledRegistrar {
    return this.#scheduled;
  }

  public get knownIds(): readonly string[] {
    return this.#subscribers.map((s) => s.id);
  }

  public missingPermissions(
    installPermissions: Readonly<Record<string, PermissionLevel>>,
    appPermissions: Readonly<Record<string, PermissionLevel>>,
    enabledIds: readonly string[],
  ): MissingPermission[] {
    const enabled = this.#subscribers.filter((s) => enabledIds.includes(s.id));

    return findMissingPermissions(enabled, installPermissions, appPermissions);
  }
}
