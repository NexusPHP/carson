import { describe, expect, it } from 'vitest';
import { parseRepository, runsWithoutSecrets } from '../../src/github/repository.js';

const pullRequest = (head: string | null, base = 'acme/widgets'): unknown => ({
  pull_request: {
    head: { repo: head === null ? null : { full_name: head } },
    base: { repo: { full_name: base } },
  },
});

describe('parseRepository', () => {
  it('splits owner and repo on the first slash', () => {
    expect(parseRepository('acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('returns null without a slash', () => {
    expect(parseRepository('widgets')).toBeNull();
  });
});

describe('runsWithoutSecrets', () => {
  it.each(['pull_request', 'pull_request_review', 'pull_request_review_comment'])('is true for %s on a pull request from a fork', (eventName) => {
    expect(runsWithoutSecrets(eventName, pullRequest('octocat/widgets'))).toBe(true);
  });

  it('is true when the fork has been deleted', () => {
    expect(runsWithoutSecrets('pull_request_review', pullRequest(null))).toBe(true);
  });

  it('is false for a pull request from the same repository', () => {
    expect(runsWithoutSecrets('pull_request_review', pullRequest('acme/widgets'))).toBe(false);
  });

  it('is false for events that do receive secrets on forks', () => {
    expect(runsWithoutSecrets('pull_request_target', pullRequest('octocat/widgets'))).toBe(false);
    expect(runsWithoutSecrets('issue_comment', pullRequest('octocat/widgets'))).toBe(false);
  });

  it('is false when the payload carries no pull request', () => {
    expect(runsWithoutSecrets('pull_request', {})).toBe(false);
  });
});
