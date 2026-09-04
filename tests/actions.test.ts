import { type ActionContext, ActionRegistrar } from '../src/actions.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logger.js';

const makeStubLog = (): Record<string, unknown> => {
  const log: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  log['child'] = vi.fn().mockReturnValue(log);

  return log;
};

const makeContext = (): ActionContext => ({
  octokit: {} as never,
  log: makeStubLog() as never,
  repo: () => ({ owner: 'acme', repo: 'widgets' }),
  config: async () => {
    await Promise.resolve();
    return null;
  },
});

describe('ActionRegistrar', () => {
  let log: Record<string, unknown>;

  beforeEach(() => {
    log = makeStubLog();
    logger.init(log as never);
  });

  it('dispatches to the registered handler with the context and request', async () => {
    const registrar = new ActionRegistrar();
    const handler = vi.fn().mockResolvedValue(undefined);
    const context = makeContext();

    registrar.on('lock', 'locker', handler);

    expect(registrar.has('lock')).toBe(true);
    await expect(registrar.dispatch('lock', context, { number: 7 })).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith(context, { number: 7 });
  });

  it('warns and resolves false when nothing handles the action', async () => {
    const registrar = new ActionRegistrar();

    expect(registrar.has('lock')).toBe(false);
    await expect(registrar.dispatch('lock', makeContext(), { number: 7 })).resolves.toBe(false);
    expect(log['warn']).toHaveBeenCalledWith('No enabled subscriber handles the "lock" action, skipping');
  });

  it('refuses a second owner for the same action', () => {
    const registrar = new ActionRegistrar();
    registrar.on('lock', 'locker', vi.fn());

    expect(() => registrar.on('lock', 'other', vi.fn()))
      .toThrow('Action "lock" is already handled by "locker"');
  });

  it('lets the same owner re-register, replacing the handler', async () => {
    const registrar = new ActionRegistrar();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    registrar.on('lock', 'locker', first);
    registrar.on('lock', 'locker', second);
    await registrar.dispatch('lock', makeContext(), { number: 1 });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
