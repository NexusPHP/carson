import { CarsonConfigSchema, subscriberSettings } from '../../src/configuration/schema.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('CarsonConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const result = CarsonConfigSchema.safeParse({
      version: 1,
      subscribers: ['welcome'],
    });

    expect(result.success).toBe(true);
  });

  it('accepts settings as an arbitrary record', () => {
    const result = CarsonConfigSchema.safeParse({
      version: 1,
      subscribers: ['welcome'],
      settings: { welcome: { pull_request: 'hi' } },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown version', () => {
    const result = CarsonConfigSchema.safeParse({
      version: 2,
      subscribers: ['welcome'],
    });

    expect(result.success).toBe(false);
  });

  it('accepts an empty subscribers list', () => {
    const result = CarsonConfigSchema.safeParse({
      version: 1,
      subscribers: [],
    });

    expect(result.success).toBe(true);
  });
});

describe('subscriberSettings', () => {
  const config = {
    version: 1 as const,
    subscribers: ['welcome'],
    settings: { welcome: { pull_request: 'hi' } },
  };

  const schema = z.object({ pull_request: z.string().optional() });

  it('parses the slice for the given subscriber id', () => {
    const result = subscriberSettings(config, 'welcome', schema);
    expect(result).toEqual({ pull_request: 'hi' });
  });

  it('returns undefined when no settings exist for the subscriber', () => {
    const result = subscriberSettings(config, 'missing', schema);
    expect(result).toBeUndefined();
  });

  it('returns undefined when the config has no settings node', () => {
    const result = subscriberSettings({ version: 1, subscribers: ['welcome'] }, 'welcome', schema);
    expect(result).toBeUndefined();
  });

  it('throws when the subscriber slice fails validation', () => {
    const bad = {
      version: 1 as const,
      subscribers: ['welcome'],
      settings: { welcome: { pull_request: 42 } },
    };
    expect(() => subscriberSettings(bad, 'welcome', schema)).toThrow();
  });
});
