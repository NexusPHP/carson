import { appIdentity } from './app-identity.js';

export type TemplateContext = Readonly<Record<string, string | number>>;

// Strip carson state markers from substituted values so attacker-controlled
// strings (PR title, commit subject) can't smuggle a marker into a bot-posted
// comment and confuse another subscriber's lookup.
const CARSON_MARKER_REGEX = /<!--\s*carson:[^>]*-->/g;

// Context entries available to every subscriber's templates. Per-call context
// passed to interpolate() wins on key conflict, so a subscriber can override.
const universalContext = (): TemplateContext => ({
  app_name: appIdentity.name,
  app_slug: appIdentity.slug,
  app_login: appIdentity.login,
});

// Escape the markdown specials that enable link/image/HTML/code breakout.
// Cosmetic markdown (*, _, ~) is left alone. Rendered output is identical
// for benign text.
export const escapeMarkdown = (s: string): string => s.replace(/[\\`[\]()<>!]/g, '\\$&');

export const interpolate = (template: string, context: TemplateContext): string => {
  const merged: TemplateContext = { ...universalContext(), ...context };

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = merged[key];

    return value === undefined ? match : String(value).replace(CARSON_MARKER_REGEX, '');
  });
};
