import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache, setRegisteredSubscribers } from '../../src/configuration/cache.js';
import type { Context } from 'probot';
import type { EmitterWebhookEventName } from '@octokit/webhooks';

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
}));

interface ContextHarness {
  context: Context<EmitterWebhookEventName>;
  configMock: ReturnType<typeof vi.fn>;
  errorMock: ReturnType<typeof vi.fn>;
  warnMock: ReturnType<typeof vi.fn>;
}

const makeContext = (raw: unknown, repo = { owner: 'acme', repo: 'widgets' }): ContextHarness => {
  const configMock = vi.fn().mockResolvedValue(raw);
  const errorMock = vi.fn();
  const warnMock = vi.fn();
  const context = {
    repo: () => repo,
    config: configMock,
    log: { error: errorMock, warn: warnMock },
  } as unknown as Context<EmitterWebhookEventName>;

  return { context, configMock, errorMock, warnMock };
};

describe('config cache', () => {
  beforeEach(() => {
    setRegisteredSubscribers(['welcome']);
    vi.mocked(core.warning).mockClear();
  });

  afterEach(() => {
    resetConfigCache();
    setRegisteredSubscribers([]);
  });

  it('returns the parsed config for a valid file', async () => {
    const { context } = makeContext({ version: 1, subscribers: ['welcome'] });
    expect(await loadConfig(context)).toEqual({ version: 1, subscribers: ['welcome'] });
  });

  it('returns null when the config file is missing', async () => {
    const { context, errorMock } = makeContext(null);
    expect(await loadConfig(context)).toBe(null);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('returns null and logs when the config fails validation', async () => {
    const { context, errorMock } = makeContext({ version: 99 });
    expect(await loadConfig(context)).toBe(null);
    expect(errorMock).toHaveBeenCalledOnce();
  });

  it('dedupes concurrent calls for the same repo', async () => {
    const { context, configMock } = makeContext({ version: 1, subscribers: ['welcome'] });
    const [a, b] = await Promise.all([loadConfig(context), loadConfig(context)]);
    expect(a).toEqual(b);
    expect(configMock).toHaveBeenCalledOnce();
  });

  it('dedupes sequential calls for the same repo', async () => {
    const { context, configMock } = makeContext({ version: 1, subscribers: ['welcome'] });
    await loadConfig(context);
    await loadConfig(context);
    expect(configMock).toHaveBeenCalledOnce();
  });

  it('keeps separate entries for different repos', async () => {
    const a = makeContext({ version: 1, subscribers: ['welcome'] }, { owner: 'acme', repo: 'widgets' });
    const b = makeContext({ version: 1, subscribers: ['welcome'] }, { owner: 'acme', repo: 'gadgets' });
    await loadConfig(a.context);
    await loadConfig(b.context);
    expect(a.configMock).toHaveBeenCalledOnce();
    expect(b.configMock).toHaveBeenCalledOnce();
  });

  it('resetConfigCache forces a refetch', async () => {
    const { context, configMock } = makeContext({ version: 1, subscribers: ['welcome'] });
    await loadConfig(context);
    resetConfigCache();
    await loadConfig(context);
    expect(configMock).toHaveBeenCalledTimes(2);
  });

  it('warns when carson.yml lists a subscriber id that is not registered', async () => {
    const { context, warnMock } = makeContext({ version: 1, subscribers: ['welcome', 'welcomee'] });
    await loadConfig(context);
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock).toHaveBeenCalledWith('carson.yml lists unknown subscriber "welcomee"');
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.warning).toHaveBeenCalledWith(
      'carson.yml lists unknown subscriber "welcomee"',
      { file: '.github/carson.yml' },
    );
  });

  it('does not warn when all subscriber ids are registered', async () => {
    const { context, warnMock } = makeContext({ version: 1, subscribers: ['welcome'] });
    await loadConfig(context);
    expect(warnMock).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });
});
