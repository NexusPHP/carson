import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../../src/configuration/cache.js';
import type { Context } from 'probot';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { logger } from '../../src/logger.js';

interface ContextHarness {
  context: Context<EmitterWebhookEventName>;
  configMock: ReturnType<typeof vi.fn>;
}

interface LoggerStub {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

const installLoggerStub = (): LoggerStub => {
  const stub: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  stub['child'] = vi.fn().mockReturnValue(stub);
  logger.init(stub as never);

  return stub as unknown as LoggerStub;
};

const makeContext = (raw: unknown, repo = { owner: 'acme', repo: 'widgets' }): ContextHarness => {
  const configMock = vi.fn().mockResolvedValue(raw);
  const context = {
    repo: () => repo,
    config: configMock,
    log: { error: vi.fn(), warn: vi.fn() },
  } as unknown as Context<EmitterWebhookEventName>;

  return { context, configMock };
};

describe('config cache', () => {
  let logStub: LoggerStub;

  beforeEach(() => {
    logger.reset();
    logStub = installLoggerStub();
  });

  afterEach(() => {
    resetConfigCache();
  });

  it('returns the parsed config for a valid file', async () => {
    const { context } = makeContext({ version: 1, subscribers: ['welcome'] });
    expect(await loadConfig(context)).toEqual({ version: 1, subscribers: ['welcome'] });
  });

  it('returns null when the config file is missing', async () => {
    const { context } = makeContext(null);
    expect(await loadConfig(context)).toBe(null);
    expect(logStub.error).not.toHaveBeenCalled();
  });

  it('returns null and logs when the config fails validation', async () => {
    const { context } = makeContext({ version: 99 });
    expect(await loadConfig(context)).toBe(null);
    expect(logStub.error).toHaveBeenCalledOnce();
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

  it('warns when carson.yml lists a subscriber id not in the knownIds list', async () => {
    const { context } = makeContext({ version: 1, subscribers: ['welcome', 'welcomee'] });
    await loadConfig(context, ['welcome']);
    expect(logStub.warn).toHaveBeenCalledOnce();
    expect(logStub.warn).toHaveBeenCalledWith('Unknown subscriber "welcomee" listed in carson.yml');
    expect(core.warning).toHaveBeenCalledOnce();
    expect(core.warning).toHaveBeenCalledWith(
      'Unknown subscriber "welcomee" listed in carson.yml',
      { file: '.github/carson.yml' },
    );
  });

  it('does not warn when all subscriber ids are in the knownIds list', async () => {
    const { context } = makeContext({ version: 1, subscribers: ['welcome'] });
    await loadConfig(context, ['welcome']);
    expect(logStub.warn).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('does not warn when knownIds is omitted', async () => {
    const { context } = makeContext({ version: 1, subscribers: ['welcome', 'whatever'] });
    await loadConfig(context);
    expect(logStub.warn).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });
});
