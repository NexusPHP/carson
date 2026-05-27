export const INVALID_REPOSITORY_MESSAGE = 'GITHUB_REPOSITORY must be in owner/repo format';

export interface ParsedRepository {
  owner: string;
  repo: string;
}

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
