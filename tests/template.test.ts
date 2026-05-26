import { describe, expect, it } from 'vitest';
import { interpolate } from '../src/template.js';

describe('interpolate', () => {
  it('substitutes a single variable', () => {
    expect(interpolate('hello {{user}}', { user: 'octocat' })).toBe('hello octocat');
  });

  it('substitutes multiple variables', () => {
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
});
