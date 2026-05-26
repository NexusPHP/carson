export type TemplateVars = Readonly<Record<string, string | number>>;

export const interpolate = (template: string, vars: TemplateVars): string =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];

    return value === undefined ? match : String(value);
  });
