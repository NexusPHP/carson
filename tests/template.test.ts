import { afterEach, describe, expect, it } from 'vitest';
import { escapeMarkdown, interpolate } from '../src/template.js';
import { appIdentity } from '../src/app-identity.js';

describe('interpolate', () => {
  afterEach(() => {
    appIdentity.reset();
  });

  it('substitutes a single placeholder from the context', () => {
    expect(interpolate('hello {{user}}', { user: 'octocat' })).toBe('hello octocat');
  });

  it('substitutes multiple placeholders from the context', () => {
    expect(interpolate('{{a}}-{{b}}-{{a}}', { a: '1', b: '2' })).toBe('1-2-1');
  });

  it('coerces numbers to strings', () => {
    expect(interpolate('issue #{{n}}', { n: 42 })).toBe('issue #42');
  });

  it('leaves unknown placeholders verbatim', () => {
    expect(interpolate('hi {{user}} on {{missing}}', { user: 'octocat' }))
      .toBe('hi octocat on {{missing}}');
  });

  it('returns the input when there are no placeholders', () => {
    expect(interpolate('plain text', { user: 'octocat' })).toBe('plain text');
  });

  it('allows whitespace inside the braces', () => {
    expect(interpolate('hi {{ user }}', { user: 'octocat' })).toBe('hi octocat');
    expect(interpolate('hi {{   user   }}', { user: 'octocat' })).toBe('hi octocat');
  });

  it('ignores placeholders with non-word characters in the key', () => {
    expect(interpolate('hi {{ user.name }}', { user: 'octocat' })).toBe('hi {{ user.name }}');
  });

  it('strips smuggled carson markers from substituted values', () => {
    expect(interpolate('title: {{t}}', { t: 'Fix <!-- carson:conflicts-notifier --> thing' }))
      .toBe('title: Fix  thing');
  });

  it('strips carson markers with surrounding whitespace and no trailing space', () => {
    expect(interpolate('{{t}}', { t: '<!--  carson:stale  --><!--carson:welcome-->ok' }))
      .toBe('ok');
  });

  it('injects {{app_name}}, {{app_slug}}, and {{app_login}} from the cached App identity', () => {
    appIdentity.set({ name: 'Carson @ acme', slug: 'carson-acme' });

    expect(interpolate('{{app_name}} ({{app_slug}}, {{app_login}})', {}))
      .toBe('Carson @ acme (carson-acme, carson-acme[bot])');
  });

  it('falls back to the carson defaults for the universal context when no App identity is cached', () => {
    expect(interpolate('{{app_name}} / {{app_slug}} / {{app_login}}', {}))
      .toBe('Carson / carson / carson[bot]');
  });

  it('lets per-call context override the injected universal context', () => {
    appIdentity.set({ name: 'Carson @ acme', slug: 'carson-acme' });

    expect(interpolate(
      '{{app_name}} / {{app_slug}} / {{app_login}}',
      { app_name: 'CustomBot', app_slug: 'custom', app_login: 'custom-bot' },
    )).toBe('CustomBot / custom / custom-bot');
  });
});

describe('escapeMarkdown', () => {
  it('escapes link, image, HTML, and code specials', () => {
    expect(escapeMarkdown('[x](http://e) `c` <b>! \\')).toBe('\\[x\\]\\(http://e\\) \\`c\\` \\<b\\>\\! \\\\');
  });

  it('leaves cosmetic markdown untouched', () => {
    expect(escapeMarkdown('*bold* _em_ ~strike~ plain')).toBe('*bold* _em_ ~strike~ plain');
  });
});
