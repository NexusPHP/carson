import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type RequiredPermissions, Subscriber } from '../src/subscriber.js';
import { Carson } from '../src/carson.js';
import { logger } from '../src/logger.js';
import type { Probot } from 'probot';
import { ScheduledRegistrar } from '../src/scheduled.js';

class FakeSubscriber extends Subscriber {
  public readonly id = 'fake';
  public readonly description = 'fake subscriber for tests';
  public readonly requiredPermissions: RequiredPermissions = {};
  public registerCalls: Probot[] = [];
  public scheduledCalls: ScheduledRegistrar[] = [];

  public override register(probot: Probot): void {
    this.registerCalls.push(probot);
  }

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    this.scheduledCalls.push(registrar);
  }
}

const makeProbot = (): Probot => {
  const log: Record<string, unknown> = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  log['child'] = vi.fn().mockReturnValue(log);

  return { log } as unknown as Probot;
};

describe('Carson', () => {
  beforeEach(() => {
    logger.reset();
  });

  it('exposes a ScheduledRegistrar via the scheduled getter', () => {
    const carson = new Carson([]);
    expect(carson.scheduled).toBeInstanceOf(ScheduledRegistrar);
  });

  it('returns the same registrar across calls', () => {
    const carson = new Carson([]);
    expect(carson.scheduled).toBe(carson.scheduled);
  });

  it('run() registers each subscriber for webhooks and scheduled events', () => {
    const sub = new FakeSubscriber();
    const carson = new Carson([sub]);
    const probot = makeProbot();

    carson.run(probot);

    expect(sub.registerCalls).toEqual([probot]);
    expect(sub.scheduledCalls).toEqual([carson.scheduled]);
  });

  it('app getter returns a function that invokes run', () => {
    const sub = new FakeSubscriber();
    const carson = new Carson([sub]);
    const probot = makeProbot();
    const options = { cwd: '.', addHandler: vi.fn() };

    carson.app(probot, options);

    expect(sub.registerCalls).toEqual([probot]);
  });

  it('knownIds returns the ids of all registered subscribers', () => {
    class NamedSub extends Subscriber {
      public constructor(public readonly id: string) {
        super();
      }

      public readonly description = 'named stub';
      public readonly requiredPermissions: RequiredPermissions = {};
    }

    const carson = new Carson([new NamedSub('alpha'), new NamedSub('beta')]);

    expect(carson.knownIds).toEqual(['alpha', 'beta']);
  });

  it('missingPermissions filters by enabledIds and includes base + enabled requirements', () => {
    class NamedSub extends Subscriber {
      public constructor(
        public readonly id: string,
        public readonly requiredPermissions: RequiredPermissions,
      ) {
        super();
      }

      public readonly description = 'named stub';
    }

    const carson = new Carson([
      new NamedSub('alpha', { issues: 'write' }),
      new NamedSub('beta', { checks: 'write' }),
    ]);

    // Only alpha is enabled. Beta's permissions are skipped.
    const missing = carson.missingPermissions({ contents: 'read' }, { contents: 'read' }, ['alpha']);

    expect(missing).toEqual([
      { subscriberId: 'alpha', permission: 'issues', required: 'write', installGranted: undefined, appDeclared: undefined },
    ]);
  });
});
