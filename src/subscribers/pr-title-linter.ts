import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { Logger } from 'pino';
import { z } from 'zod';

const Rule = z.object({
  pattern: z.string(),
  description: z.string(),
  mode: z.enum(['require', 'forbid']).optional(),
  level: z.enum(['error', 'warning']).optional(),
});

const Settings = z.object({
  name: z.string().optional(),
  rules: z.array(Rule).optional(),
});

type ParsedRule = z.infer<typeof Rule>;

const DEFAULT_NAME = 'Carson / pr-title-linter';
const DEFAULT_MODE: 'require' | 'forbid' = 'require';
const DEFAULT_LEVEL: 'error' | 'warning' = 'error';

type PrTitleEvent = 'pull_request.opened' | 'pull_request.edited';
type PrTitleContext = Context<PrTitleEvent>;

const PR_EVENTS: PrTitleEvent[] = ['pull_request.opened', 'pull_request.edited'];

interface CompiledRule {
  rule: ParsedRule;
  regex: RegExp;
}

interface RuleFailure {
  description: string;
  level: 'error' | 'warning';
  mode: 'require' | 'forbid';
}

const compileRules = (rules: readonly ParsedRule[], log: Logger): CompiledRule[] => {
  const compiled: CompiledRule[] = [];

  for (const rule of rules) {
    try {
      compiled.push({ rule, regex: new RegExp(rule.pattern) });
    } catch (error) {
      log.warn(`Skipping rule "${rule.description}": invalid regex (${String(error)})`);
    }
  }

  return compiled;
};

const evaluate = (title: string, compiled: readonly CompiledRule[]): RuleFailure[] =>
  compiled
    .filter(({ rule, regex }) => {
      const matches = regex.test(title);
      const mode = rule.mode ?? DEFAULT_MODE;

      return mode === 'require' ? !matches : matches;
    })
    .map(({ rule }) => ({
      description: rule.description,
      level: rule.level ?? DEFAULT_LEVEL,
      mode: rule.mode ?? DEFAULT_MODE,
    }));

const conclusionFor = (failures: readonly RuleFailure[]): 'success' | 'failure' | 'neutral' => {
  if (failures.length === 0) {
    return 'success';
  }

  return failures.some((f) => f.level === 'error') ? 'failure' : 'neutral';
};

const outputFor = (
  failures: readonly RuleFailure[],
  totalRules: number,
): { title: string; summary: string; text?: string } => {
  if (failures.length === 0) {
    return {
      title: `Title passes all ${totalRules} rule(s)`,
      summary: 'Every configured rule matched the pull request title.',
    };
  }

  const text = failures
    .map((f) => `- **${f.level}** (${f.mode}): ${f.description}`)
    .join('\n');

  return {
    title: `${failures.length} of ${totalRules} rule(s) failed`,
    summary: 'One or more title rules did not match. See details for the offending rules.',
    text,
  };
};

export class PrTitleLinterSubscriber extends Subscriber {
  public readonly id = 'pr-title-linter';
  public readonly description = 'Validates pull request titles against a configurable set of regex rules and reports the result as a check run.';
  public readonly requiredPermissions: RequiredPermissions = {
    checks: 'write',
    pull_requests: 'read',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context as PrTitleContext);
    });
  }

  async #handle(context: PrTitleContext): Promise<void> {
    const log = this.log(context);
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const rules = settings.rules ?? [];

    if (rules.length === 0) {
      log.debug('No rules configured, skipping');

      return;
    }

    const compiled = compileRules(rules, log);

    if (compiled.length === 0) {
      log.debug('No valid rules to evaluate, skipping');

      return;
    }

    const pr = context.payload.pull_request;
    const failures = evaluate(pr.title, compiled);
    const conclusion = conclusionFor(failures);
    const output = outputFor(failures, compiled.length);
    const { owner, repo } = context.repo();

    await context.octokit.rest.checks.create({
      owner,
      repo,
      name: settings.name ?? DEFAULT_NAME,
      head_sha: pr.head.sha,
      status: 'completed',
      conclusion,
      output,
    });

    log.info(`Check ${conclusion} for PR #${pr.number}`);
  }
}
