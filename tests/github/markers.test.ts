import { buildIssueIntakeMarker, parseIssueIntakeMarker } from '../../src/github/markers.js';
import { describe, expect, it } from 'vitest';

describe('buildIssueIntakeMarker', () => {
  it('emits the canonical marker form', () => {
    expect(buildIssueIntakeMarker('support-ticket', 'tkt_8f3a2c'))
      .toBe('<!-- carson:issue-intake:support-ticket:tkt_8f3a2c -->');
  });
});

describe('parseIssueIntakeMarker', () => {
  it('round-trips the canonical form as the final line of a body', () => {
    const body = `Some issue body\n\n${buildIssueIntakeMarker('support-ticket', 'tkt_8f3a2c')}`;

    expect(parseIssueIntakeMarker(body)).toEqual({ eventType: 'support-ticket', ref: 'tkt_8f3a2c' });
  });

  it('parses leniently: extra whitespace inside the comment and trailing whitespace after it', () => {
    expect(parseIssueIntakeMarker('body\n<!--  carson:issue-intake:support-ticket:t-1  -->\n  '))
      .toEqual({ eventType: 'support-ticket', ref: 't-1' });
  });

  it('keeps colons inside the event type by taking the last segment as the ref', () => {
    expect(parseIssueIntakeMarker('<!-- carson:issue-intake:ns:sub-type:ref.1 -->'))
      .toEqual({ eventType: 'ns:sub-type', ref: 'ref.1' });
  });

  it('rejects a marker that is not at the end of the body', () => {
    expect(parseIssueIntakeMarker('<!-- carson:issue-intake:support-ticket:t-1 -->\ntrailing text')).toBeNull();
  });

  it('rejects a ref outside the allowed charset', () => {
    expect(parseIssueIntakeMarker('<!-- carson:issue-intake:support-ticket:bad ref -->')).toBeNull();
  });

  it('rejects markers of other subscribers', () => {
    expect(parseIssueIntakeMarker('<!-- carson:conflicts-notifier -->')).toBeNull();
  });

  it('returns null for a null or undefined body', () => {
    expect(parseIssueIntakeMarker(null)).toBeNull();
    expect(parseIssueIntakeMarker(undefined)).toBeNull();
  });
});
