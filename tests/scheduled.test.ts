import { describe, expect, it, vi } from 'vitest';
import { dispatchScheduled, type ScheduledHandler, ScheduledRegistrar } from '../src/scheduled.js';
import type { Probot } from 'probot';

interface ProbotHarness {
  probot: Probot;
  getRepoInstallation: ReturnType<typeof vi.fn>;
  installationOctokit: { tag: string };
}

const makeProbot = (installationId = 99): ProbotHarness => {
  const installationOctokit = { tag: 'installation' };
  const getRepoInstallation = vi.fn().mockResolvedValue({ data: { id: installationId } });
  const appOctokit = { rest: { apps: { getRepoInstallation } } };
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  const auth = vi.fn(async (id?: number) => {
    await Promise.resolve();
    return id === undefined ? appOctokit : installationOctokit;
  });

  const probot = { auth, log } as unknown as Probot;

  return { probot, getRepoInstallation, installationOctokit };
};

describe('ScheduledRegistrar', () => {
  it('starts empty', () => {
    const registrar = new ScheduledRegistrar();
    expect(registrar.handlers).toEqual([]);
  });

  it('appends handlers in order', () => {
    const registrar = new ScheduledRegistrar();
    const a = vi.fn().mockResolvedValue(undefined) as unknown as ScheduledHandler;
    const b = vi.fn().mockResolvedValue(undefined) as unknown as ScheduledHandler;
    registrar.on(a);
    registrar.on(b);
    expect(registrar.handlers).toEqual([a, b]);
  });
});

describe('dispatchScheduled', () => {
  const payload = { schedule: '0 * * * *', workflow: '.github/workflows/cron.yml' };

  it('resolves the installation and invokes each handler with a built context', async () => {
    const { probot, getRepoInstallation, installationOctokit } = makeProbot(42);
    const registrar = new ScheduledRegistrar();
    const handler = vi.fn().mockResolvedValue(undefined);
    registrar.on(handler as unknown as ScheduledHandler);

    const result = await dispatchScheduled(probot, registrar, 'acme/widgets', payload);

    expect(getRepoInstallation).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets' });
    expect(result).toEqual({ failed: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      octokit: installationOctokit,
      owner: 'acme',
      repo: 'widgets',
      payload,
    });
  });

  it('splits owner and repo on the first slash only', async () => {
    const { probot } = makeProbot();
    const registrar = new ScheduledRegistrar();
    const handler = vi.fn().mockResolvedValue(undefined);
    registrar.on(handler as unknown as ScheduledHandler);

    await dispatchScheduled(probot, registrar, 'acme/widgets', payload);

    expect(handler.mock.calls[0]?.[0]).toMatchObject({ owner: 'acme', repo: 'widgets' });
  });

  it('throws when GITHUB_REPOSITORY is not in owner/repo format', async () => {
    const { probot } = makeProbot();
    const registrar = new ScheduledRegistrar();

    await expect(dispatchScheduled(probot, registrar, 'no-slash', payload)).rejects.toThrow(
      'GITHUB_REPOSITORY must be in owner/repo format',
    );
  });

  it('returns failed: true and continues when a handler throws', async () => {
    const { probot } = makeProbot();
    const registrar = new ScheduledRegistrar();
    const callOrder: string[] = [];
    const failing = vi.fn(async () => {
      await Promise.resolve();
      callOrder.push('failing');
      throw new Error('boom');
    });
    const second = vi.fn(async () => {
      await Promise.resolve();
      callOrder.push('second');
    });
    registrar.on(failing as unknown as ScheduledHandler);
    registrar.on(second as unknown as ScheduledHandler);

    const result = await dispatchScheduled(probot, registrar, 'acme/widgets', payload);

    expect(result).toEqual({ failed: true });
    expect(callOrder).toEqual(['failing', 'second']);
  });

  it('returns failed: false when there are no handlers', async () => {
    const { probot } = makeProbot();
    const registrar = new ScheduledRegistrar();

    const result = await dispatchScheduled(probot, registrar, 'acme/widgets', payload);

    expect(result).toEqual({ failed: false });
  });
});
