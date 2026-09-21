export const INVALID_REPOSITORY_MESSAGE = 'GITHUB_REPOSITORY must be in owner/repo format';

export interface ParsedRepository {
  owner: string;
  repo: string;
}

const SECRETLESS_ON_FORKS: readonly string[] = ['pull_request', 'pull_request_review', 'pull_request_review_comment'];

interface ForkablePayload {
  pull_request?: {
    head?: { repo?: { full_name?: unknown } | null };
    base?: { repo?: { full_name?: unknown } };
  };
}

// GitHub withholds secrets from these events when the pull request comes from a fork.
export const runsWithoutSecrets = (eventName: string, payload: unknown): boolean => {
  if (!SECRETLESS_ON_FORKS.includes(eventName)) {
    return false;
  }

  const pr = (payload as ForkablePayload).pull_request;
  const base = pr?.base?.repo?.full_name;

  return typeof base === 'string' && pr?.head?.repo?.full_name !== base;
};

export const parseRepository = (input: string): ParsedRepository | null => {
  const slash = input.indexOf('/');

  if (slash === -1) {
    return null;
  }

  return {
    owner: input.slice(0, slash),
    repo: input.slice(slash + 1),
  };
};
