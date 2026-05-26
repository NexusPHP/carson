import { getAppLogin, getAppName, getAppSlug } from './app-identity.js';

export type TemplateContext = Readonly<Record<string, string | number>>;

// Strip carson state markers from substituted values so attacker-controlled
// strings (PR title, commit subject) can't smuggle a marker into a bot-posted
// comment and confuse another subscriber's lookup.
const CARSON_MARKER_REGEX = /<!--\s*carson:[^>]*-->/g;

// Context entries available to every subscriber's templates. Per-call context
// passed to interpolate() wins on key conflict, so a subscriber can override.
const universalContext = (): TemplateContext => ({
  app_name: getAppName(),
  app_slug: getAppSlug(),
  app_login: getAppLogin(),
});

export const interpolate = (template: string, context: TemplateContext): string => {
  const merged: TemplateContext = { ...universalContext(), ...context };

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = merged[key];

    return value === undefined ? match : String(value).replace(CARSON_MARKER_REGEX, '');
  });
};
