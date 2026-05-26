import { afterEach, describe, expect, it } from 'vitest';
import { getAppIdentity, getAppLogin, getAppName, getAppSlug, resetAppIdentity, setAppIdentity } from '../src/app-identity.js';

describe('app-identity', () => {
  afterEach(() => {
    resetAppIdentity();
  });

  it('returns null when no identity has been set', () => {
    expect(getAppIdentity()).toBeNull();
  });

  it('returns "Carson" as the default app name when no identity has been set', () => {
    expect(getAppName()).toBe('Carson');
  });

  it('returns "carson" as the default app slug when no identity has been set', () => {
    expect(getAppSlug()).toBe('carson');
  });

  it('returns "carson[bot]" as the default app login when no identity has been set', () => {
    expect(getAppLogin()).toBe('carson[bot]');
  });

  it('exposes the configured identity after setAppIdentity', () => {
    setAppIdentity({ name: 'Carson @ acme', slug: 'carson-acme', id: 42 });

    expect(getAppIdentity()).toEqual({ name: 'Carson @ acme', slug: 'carson-acme', id: 42 });
    expect(getAppName()).toBe('Carson @ acme');
    expect(getAppSlug()).toBe('carson-acme');
    expect(getAppLogin()).toBe('carson-acme[bot]');
  });

  it('clears the cached identity on reset', () => {
    setAppIdentity({ name: 'Carson @ acme', slug: 'carson-acme', id: 42 });
    resetAppIdentity();

    expect(getAppIdentity()).toBeNull();
    expect(getAppName()).toBe('Carson');
    expect(getAppSlug()).toBe('carson');
    expect(getAppLogin()).toBe('carson[bot]');
  });
});
