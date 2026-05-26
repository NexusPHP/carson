import { describe, expect, it, vi } from 'vitest';
import { Carson } from '../src/carson.js';
import type { Probot } from 'probot';
import { ScheduledRegistrar } from '../src/scheduled.js';
import { Subscriber } from '../src/subscriber.js';

class FakeSubscriber extends Subscriber {
  public readonly id = 'fake';
  public readonly description = 'fake subscriber for tests';
  public registerCalls: Probot[] = [];
  public scheduledCalls: ScheduledRegistrar[] = [];

  public register(probot: Probot): void {
    this.registerCalls.push(probot);
  }

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    this.scheduledCalls.push(registrar);
  }
}

const makeProbot = (): Probot => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
} as unknown as Probot);

describe('Carson', () => {
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
});
