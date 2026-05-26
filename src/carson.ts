import type { ApplicationFunction, Probot } from 'probot';
import { setRegisteredSubscribers } from './configuration/cache.js';
import type { Subscriber } from './subscriber.js';

export class Carson {
  public static readonly DISPLAY_NAME: string = 'Carson';
  readonly #subscribers: readonly Subscriber[];

  public constructor(subscribers: readonly Subscriber[]) {
    this.#subscribers = subscribers;
  }

  public run(probot: Probot): void {
    probot.log.info(`${Carson.DISPLAY_NAME} starting`);
    setRegisteredSubscribers(this.#subscribers.map((s) => s.id));

    for (const subscriber of this.#subscribers) {
      probot.log.info(`Registering subscriber: ${subscriber.id}`);
      subscriber.register(probot);
    }
  }

  public get app(): ApplicationFunction {
    return (probot: Probot): void => {
      this.run(probot);
    };
  }
}
