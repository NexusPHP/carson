// Cached identity of the GitHub App the action is currently running as.
// Set once by the preflight after a successful `apps.getAuthenticated` call,
// then read by subscribers that interpolate the App name into messages and
// by the entrypoint for traceability logging.

export interface AppIdentity {
  readonly name: string;
  readonly slug: string;
  readonly id: number;
}

let cached: AppIdentity | null = null;

export const setAppIdentity = (identity: AppIdentity): void => {
  cached = identity;
};

export const getAppIdentity = (): AppIdentity | null => cached;

// Returns the App's display name with a sensible default for environments
// where the identity has not been resolved (preflight skipped, tests, etc.).
export const getAppName = (): string => cached?.name ?? 'Carson';

export const resetAppIdentity = (): void => {
  cached = null;
};
