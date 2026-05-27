import { afterEach, describe, expect, it } from 'vitest';
import { appIdentity } from '../src/app-identity.js';

describe('app-identity', () => {
  afterEach(() => {
    appIdentity.reset();
  });

  it('returns null when no identity has been set', () => {
    expect(appIdentity.current).toBeNull();
  });

  it('returns "Carson" as the default app name when no identity has been set', () => {
    expect(appIdentity.name).toBe('Carson');
  });

  it('returns "carson" as the default app slug when no identity has been set', () => {
    expect(appIdentity.slug).toBe('carson');
  });

  it('returns "carson[bot]" as the default app login when no identity has been set', () => {
    expect(appIdentity.login).toBe('carson[bot]');
  });

  it('exposes the configured identity after set', () => {
    appIdentity.set({ name: 'Carson @ acme', slug: 'carson-acme' });

    expect(appIdentity.current).toEqual({ name: 'Carson @ acme', slug: 'carson-acme' });
    expect(appIdentity.name).toBe('Carson @ acme');
    expect(appIdentity.slug).toBe('carson-acme');
    expect(appIdentity.login).toBe('carson-acme[bot]');
  });

  it('clears the cached identity on reset', () => {
    appIdentity.set({ name: 'Carson @ acme', slug: 'carson-acme' });
    appIdentity.reset();

    expect(appIdentity.current).toBeNull();
    expect(appIdentity.name).toBe('Carson');
    expect(appIdentity.slug).toBe('carson');
    expect(appIdentity.login).toBe('carson[bot]');
  });
});
