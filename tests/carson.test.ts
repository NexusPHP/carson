import type { ActionContext, ActionRegistrar } from '../src/actions.js';
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
  public actionsCalls: ActionRegistrar[] = [];

  public override register(probot: Probot): void {
    this.registerCalls.push(probot);
  }

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    this.scheduledCalls.push(registrar);
  }

  public override registerActions(registrar: ActionRegistrar): void {
    this.actionsCalls.push(registrar);
  }

  public async requestLock(context: ActionContext, number: number): Promise<boolean> {
    return await this.dispatch('lock', context, { number });
  }
}

const makeContext = (): ActionContext => {
  const log: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log['child'] = vi.fn().mockReturnValue(log);

  return {
    octokit: {} as never,
    log: log as never,
    repo: () => ({ owner: 'acme', repo: 'widgets' }),
    config: async () => {
      await Promise.resolve();
      return null;
    },
  };
};

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

  it('run() registers each subscriber for webhooks, scheduled events, and actions', () => {
    const sub = new FakeSubscriber();
    const carson = new Carson([sub]);
    const probot = makeProbot();

    carson.run(probot);

    expect(sub.registerCalls).toEqual([probot]);
    expect(sub.scheduledCalls).toEqual([carson.scheduled]);
    expect(sub.actionsCalls).toEqual([carson.actions]);
  });

  it('run() binds the action router so subscribers can dispatch to each other', async () => {
    const sub = new FakeSubscriber();
    const carson = new Carson([sub]);
    const handler = vi.fn().mockResolvedValue(undefined);
    const context = makeContext();

    carson.run(makeProbot());
    carson.actions.on('lock', 'locker', handler);

    await expect(sub.requestLock(context, 7)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith(context, { number: 7 });
  });

  it('dispatch() warns and resolves false when no router is bound', async () => {
    const sub = new FakeSubscriber();
    const context = makeContext();

    await expect(sub.requestLock(context, 7)).resolves.toBe(false);
    expect(context.log.warn).toHaveBeenCalledWith('No action router bound, cannot dispatch "lock"');
  });

  it('run() only registers subscribers listed in enabledIds when it is provided', () => {
    class NamedFakeSubscriber extends Subscriber {
      public readonly description = 'named fake subscriber for tests';
      public readonly requiredPermissions: RequiredPermissions = {};
      public registerCalls: Probot[] = [];
      public scheduledCalls: ScheduledRegistrar[] = [];

      public constructor(public readonly id: string) {
        super();
      }

      public override register(probot: Probot): void {
        this.registerCalls.push(probot);
      }

      public override registerScheduled(registrar: ScheduledRegistrar): void {
        this.scheduledCalls.push(registrar);
      }
    }

    const enabled = new NamedFakeSubscriber('enabled');
    const disabled = new NamedFakeSubscriber('disabled');
    const carson = new Carson([enabled, disabled]);
    const probot = makeProbot();

    carson.run(probot, ['enabled']);

    expect(enabled.registerCalls).toEqual([probot]);
    expect(enabled.scheduledCalls).toEqual([carson.scheduled]);
    expect(disabled.registerCalls).toEqual([]);
    expect(disabled.scheduledCalls).toEqual([]);
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
