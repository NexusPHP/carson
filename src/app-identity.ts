// Cached identity of the GitHub App the action is currently running as.
// Set once by the preflight after a successful `apps.getAuthenticated` call,
// then read by subscribers that interpolate the App name into messages and
// by the entrypoint for traceability logging. The numeric App ID is omitted
// because it is sensitive when paired with the App PEM.

export interface AppIdentity {
  readonly name: string;
  readonly slug: string;
}

let cached: AppIdentity | null = null;

export const setAppIdentity = (identity: AppIdentity): void => {
  cached = identity;
};

export const getAppIdentity = (): AppIdentity | null => cached;

// Returns the App's display name with a sensible default for environments
// where the identity has not been resolved (preflight skipped, tests, etc.).
export const getAppName = (): string => cached?.name ?? 'Carson';

// Returns the App's URL-safe slug, used in the App settings URL
// (`https://github.com/apps/<slug>`). Falls back to the manifest default.
export const getAppSlug = (): string => cached?.slug ?? 'carson';

// Returns the bot user's GitHub login: `<slug>[bot]`. This is the author of
// comments and check runs Carson posts, and is suffixed because GitHub
// distinguishes bot accounts from human accounts that way.
export const getAppLogin = (): string => `${getAppSlug()}[bot]`;

export const resetAppIdentity = (): void => {
  cached = null;
};
