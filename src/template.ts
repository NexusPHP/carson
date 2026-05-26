import { getAppLogin, getAppName, getAppSlug } from './app-identity.js';

export type TemplateVars = Readonly<Record<string, string | number>>;

// Strip carson state markers from substituted values so attacker-controlled
// strings (PR title, commit subject) can't smuggle a marker into a bot-posted
// comment and confuse another subscriber's lookup.
const CARSON_MARKER_REGEX = /<!--\s*carson:[^>]*-->/g;

// Variables available to every subscriber's templates. Per-call vars passed
// to interpolate() win on key conflict, so a subscriber can override them.
const universalVars = (): TemplateVars => ({
  app_name: getAppName(),
  app_slug: getAppSlug(),
  app_login: getAppLogin(),
});

export const interpolate = (template: string, vars: TemplateVars): string => {
  const merged: TemplateVars = { ...universalVars(), ...vars };

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = merged[key];

    return value === undefined ? match : String(value).replace(CARSON_MARKER_REGEX, '');
  });
};
