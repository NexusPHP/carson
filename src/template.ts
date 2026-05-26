export type TemplateVars = Readonly<Record<string, string | number>>;

// Strip carson state markers from substituted values so attacker-controlled
// strings (PR title, commit subject) can't smuggle a marker into a bot-posted
// comment and confuse another subscriber's lookup.
const CARSON_MARKER_REGEX = /<!--\s*carson:[^>]*-->/g;

export const interpolate = (template: string, vars: TemplateVars): string =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];

    return value === undefined ? match : String(value).replace(CARSON_MARKER_REGEX, '');
  });
