import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { Logger } from 'pino';
import picomatch from 'picomatch';
import { z } from 'zod';

const StringArray = z.array(z.string());

const FilesMatcher = z.union([
  StringArray,
  z.object({
    any: StringArray.optional(),
    all: StringArray.optional(),
  }),
]);

const Rule = z.object({
  label: z.string(),
  files: FilesMatcher.optional(),
  title: StringArray.optional(),
  body: StringArray.optional(),
  head_branch: StringArray.optional(),
  base_branch: StringArray.optional(),
});

const Settings = z.object({
  sync_labels: z.boolean().optional(),
  rules: z.array(Rule).optional(),
});

type ParsedRule = z.infer<typeof Rule>;
type ParsedFilesMatcher = z.infer<typeof FilesMatcher>;

type LabelEvent
  = | 'pull_request.opened'
    | 'pull_request.reopened'
    | 'pull_request.synchronize'
    | 'pull_request.edited';
type LabelContext = Context<LabelEvent>;

const PR_EVENTS: LabelEvent[] = [
  'pull_request.opened',
  'pull_request.reopened',
  'pull_request.synchronize',
  'pull_request.edited',
];

type FilesPredicate = (files: readonly string[]) => boolean;

interface CompiledMatchers {
  files: FilesPredicate | null;
  title: RegExp[];
  body: RegExp[];
  head_branch: RegExp[];
  base_branch: RegExp[];
}

interface CompiledRule {
  label: string;
  matchers: CompiledMatchers;
  usesFiles: boolean;
}

const compileAnyMatcher = (globs: readonly string[]): FilesPredicate | null => {
  if (globs.length === 0) {
    return null;
  }

  const matchers = globs.map((glob) => picomatch(glob));

  return (files) => files.some((f) => matchers.some((m) => m(f)));
};

const compileAllMatcher = (globs: readonly string[]): FilesPredicate | null => {
  if (globs.length === 0) {
    return null;
  }

  const matchers = globs.map((glob) => picomatch(glob));

  return (files) => files.length > 0 && files.every((f) => matchers.some((m) => m(f)));
};

const compileFilesMatcher = (matcher: ParsedFilesMatcher): FilesPredicate | null => {
  if (Array.isArray(matcher)) {
    return compileAnyMatcher(matcher);
  }

  const anyFn = matcher.any !== undefined ? compileAnyMatcher(matcher.any) : null;
  const allFn = matcher.all !== undefined ? compileAllMatcher(matcher.all) : null;

  if (anyFn === null && allFn === null) {
    return null;
  }

  if (anyFn === null) {
    return allFn;
  }

  if (allFn === null) {
    return anyFn;
  }

  return (files) => anyFn(files) && allFn(files);
};

const compileRegexes = (patterns: readonly string[], log: Logger, label: string): RegExp[] => {
  const out: RegExp[] = [];

  for (const pattern of patterns) {
    try {
      out.push(new RegExp(pattern));
    } catch (error) {
      log.warn(`Rule "${label}": invalid regex "${pattern}" (${String(error)}), skipping`);
    }
  }

  return out;
};

const compileRule = (rule: ParsedRule, log: Logger): CompiledRule => ({
  label: rule.label,
  usesFiles: rule.files !== undefined,
  matchers: {
    files: rule.files !== undefined ? compileFilesMatcher(rule.files) : null,
    title: rule.title !== undefined ? compileRegexes(rule.title, log, rule.label) : [],
    body: rule.body !== undefined ? compileRegexes(rule.body, log, rule.label) : [],
    head_branch: rule.head_branch !== undefined ? compileRegexes(rule.head_branch, log, rule.label) : [],
    base_branch: rule.base_branch !== undefined ? compileRegexes(rule.base_branch, log, rule.label) : [],
  },
});

interface PrFields {
  title: string;
  body: string;
  head: string;
  base: string;
}

const ruleMatches = (rule: CompiledRule, fields: PrFields, files: readonly string[]): boolean => {
  const m = rule.matchers;

  if (m.files?.(files) === true) {
    return true;
  }

  if (m.title.some((r) => r.test(fields.title))) {
    return true;
  }

  if (m.body.some((r) => r.test(fields.body))) {
    return true;
  }

  if (m.head_branch.some((r) => r.test(fields.head))) {
    return true;
  }

  if (m.base_branch.some((r) => r.test(fields.base))) {
    return true;
  }

  return false;
};

export class AutoLabelerSubscriber extends Subscriber {
  public readonly id = 'auto-labeler';
  public readonly description = 'Adds labels to pull requests based on path globs, title or body regex, and branch name patterns. Optional sync mode removes managed labels that no longer match.';
  public readonly requiredPermissions: RequiredPermissions = {
    issues: 'write',
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context as LabelContext);
    });
  }

  async #handle(context: LabelContext): Promise<void> {
    const log = this.log(context);
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const rawRules = settings.rules ?? [];

    if (rawRules.length === 0) {
      log.debug('No rules configured, skipping');

      return;
    }

    const compiled = rawRules.map((r) => compileRule(r, log));
    const usesFiles = compiled.some((r) => r.usesFiles);
    const pr = context.payload.pull_request;
    const { owner, repo } = context.repo();

    let filenames: string[] = [];

    if (usesFiles) {
      const files = await context.octokit.paginate(context.octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });
      filenames = files.map((f) => f.filename);
    }

    const fields: PrFields = {
      title: pr.title,
      body: pr.body ?? '',
      head: pr.head.ref,
      base: pr.base.ref,
    };

    const matched = new Set<string>();
    const managed = new Set<string>();

    for (const rule of compiled) {
      managed.add(rule.label);

      if (ruleMatches(rule, fields, filenames)) {
        matched.add(rule.label);
      }
    }

    const current = new Set(pr.labels.map((l) => l.name));
    const toAdd = Array.from(matched).filter((l) => !current.has(l));
    const syncLabels = settings.sync_labels ?? false;
    const toRemove = syncLabels
      ? Array.from(current).filter((l) => managed.has(l) && !matched.has(l))
      : [];

    if (toAdd.length > 0) {
      await context.octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: pr.number,
        labels: toAdd,
      });
      log.info(`Added ${toAdd.length} label(s) to PR #${pr.number}: ${toAdd.join(', ')}`);
    }

    for (const label of toRemove) {
      await context.octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: pr.number,
        name: label,
      });
    }

    if (toRemove.length > 0) {
      log.info(`Removed ${toRemove.length} label(s) from PR #${pr.number}: ${toRemove.join(', ')}`);
    }
  }
}
