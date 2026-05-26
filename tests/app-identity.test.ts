import { afterEach, describe, expect, it } from 'vitest';
import { getAppIdentity, getAppName, resetAppIdentity, setAppIdentity } from '../src/app-identity.js';

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

  it('exposes the configured identity after setAppIdentity', () => {
    setAppIdentity({ name: 'Carson @ acme', slug: 'carson-acme', id: 42 });

    expect(getAppIdentity()).toEqual({ name: 'Carson @ acme', slug: 'carson-acme', id: 42 });
    expect(getAppName()).toBe('Carson @ acme');
  });

  it('clears the cached identity on reset', () => {
    setAppIdentity({ name: 'Carson @ acme', slug: 'carson-acme', id: 42 });
    resetAppIdentity();

    expect(getAppIdentity()).toBeNull();
    expect(getAppName()).toBe('Carson');
  });
});
