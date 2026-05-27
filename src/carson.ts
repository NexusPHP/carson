import type { ApplicationFunction, Probot } from 'probot';
import { dirname, resolve } from 'node:path';
import { findMissingPermissions, type MissingPermission } from './preflight.js';
import type { PermissionLevel, Subscriber } from './subscriber.js';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { readFileSync } from 'node:fs';
import { ScheduledRegistrar } from './scheduled.js';

// Probot's exports field blocks `probot/package.json`, so read the declared
// spec from Carson's own package.json (always shipped alongside dist/).
const carsonPackage = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string; dependencies: { probot: string } };
const carsonVersion = carsonPackage.version;
const probotVersion = carsonPackage.dependencies.probot.replace(/^[\^~]/, '');

export class Carson {
  public static readonly DISPLAY_NAME: string = 'Carson';
  readonly #subscribers: readonly Subscriber[];
  readonly #scheduled = new ScheduledRegistrar();

  public constructor(subscribers: readonly Subscriber[]) {
    this.#subscribers = subscribers;
  }

  public run(probot: Probot): void {
    logger.init(probot.log);
    const log = logger.for('carson');
    log.info(`${Carson.DISPLAY_NAME} v${carsonVersion} starting (Probot v${probotVersion}, Node ${process.version})`);

    for (const subscriber of this.#subscribers) {
      log.info(`Registering subscriber: ${subscriber.id}`);
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
