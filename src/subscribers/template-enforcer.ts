import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { findCarsonComment } from '../github/comments.js';
import { interpolate } from '../template.js';
import type { Logger } from 'pino';
import { z } from 'zod';

const Rule = z.object({
  pattern: z.string(),
  description: z.string(),
  mode: z.enum(['require', 'forbid']).optional(),
});

const TypeSettings = z.object({
  required_sections: z.array(z.string()).optional(),
  min_length: z.number().int().positive().optional(),
  rules: z.array(Rule).optional(),
});

const Settings = z.object({
  label: z.string().optional(),
  message: z.string().optional(),
  issues: TypeSettings.optional(),
  pull_requests: TypeSettings.optional(),
});

const COMMENT_MARKER = '<!-- carson:template-enforcer -->';
const DEFAULT_LABEL = 'needs-template';
const DEFAULT_MESSAGE = [
  'Thanks for opening this {{type}}, @{{user}}! The description doesn\'t match the template:',
  '',
  '{{violations}}',
  '',
  'Please update the description. The `{{label}}` label will be removed automatically.',
].join('\n');

type ItemKind = 'issue' | 'pull_request';
type IssueEvent = 'issues.opened' | 'issues.edited';
type PrEvent = 'pull_request.opened' | 'pull_request.edited';

const ISSUE_EVENTS: IssueEvent[] = ['issues.opened', 'issues.edited'];
const PR_EVENTS: PrEvent[] = ['pull_request.opened', 'pull_request.edited'];

interface Item {
  number: number;
  body: string;
  title: string;
  user: string;
  labels: readonly string[];
}

interface CompiledRule {
  description: string;
  mode: 'require' | 'forbid';
  regex: RegExp;
}

const compileRules = (rules: readonly z.infer<typeof Rule>[], log: Logger): CompiledRule[] => {
  const compiled: CompiledRule[] = [];

  for (const rule of rules) {
    try {
      compiled.push({
        description: rule.description,
        mode: rule.mode ?? 'require',
        regex: new RegExp(rule.pattern),
      });
    } catch (error) {
      log.warn(`Skipping rule "${rule.description}": invalid regex (${String(error)})`);
    }
  }

  return compiled;
};

const collectViolations = (
  body: string,
  rules: z.infer<typeof TypeSettings>,
  log: Logger,
): string[] => {
  const violations: string[] = [];
  const lower = body.toLowerCase();

  for (const section of rules.required_sections ?? []) {
    if (!lower.includes(section.toLowerCase())) {
      violations.push(`Required section missing: \`${section}\``);
    }
  }

  if (rules.min_length !== undefined && body.trim().length < rules.min_length) {
    violations.push(`Description too short (minimum ${rules.min_length} characters).`);
  }

  for (const compiled of compileRules(rules.rules ?? [], log)) {
    const matches = compiled.regex.test(body);
    const failed = compiled.mode === 'require' ? !matches : matches;

    if (failed) {
      violations.push(compiled.description);
    }
  }

  return violations;
};

const renderViolations = (violations: readonly string[]): string =>
  violations.map((v) => `- ${v}`).join('\n');

const typeLabel = (kind: ItemKind): string => (kind === 'issue' ? 'issue' : 'pull request');

export class TemplateEnforcerSubscriber extends Subscriber {
  public readonly id = 'template-enforcer';
  public readonly description = 'Comments and labels issues or pull requests whose description does not match the configured template.';
  public readonly requiredPermissions: RequiredPermissions = {
    issues: 'write',
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(ISSUE_EVENTS, async (context): Promise<void> => {
      await this.#handleIssue(context);
    });
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handlePr(context);
    });
  }

  async #handleIssue(context: Context<IssueEvent>): Promise<void> {
    const issue = context.payload.issue;

    if (issue.user === null) {
      return;
    }

    await this.#apply(context, 'issue', {
      number: issue.number,
      body: issue.body ?? '',
      title: issue.title,
      user: issue.user.login,
      labels: issue.labels?.map((l) => l.name) ?? [],
    });
  }

  async #handlePr(context: Context<PrEvent>): Promise<void> {
    const pr = context.payload.pull_request;

    if (pr.user === null) {
      return;
    }

    await this.#apply(context, 'pull_request', {
      number: pr.number,
      body: pr.body ?? '',
      title: pr.title,
      user: pr.user.login,
      labels: pr.labels?.map((l) => l.name) ?? [],
    });
  }

  async #apply(context: Context<IssueEvent | PrEvent>, kind: ItemKind, item: Item): Promise<void> {
    const log = this.log(context);
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const typeRules = kind === 'issue' ? settings.issues : settings.pull_requests;

    if (typeRules === undefined) {
      log.debug(`No rules configured for ${typeLabel(kind)}, skipping`);

      return;
    }

    const label = settings.label ?? DEFAULT_LABEL;
    const messageTemplate = settings.message ?? DEFAULT_MESSAGE;
    const violations = collectViolations(item.body, typeRules, log);
    const hasLabel = item.labels.includes(label);
    const { owner, repo } = context.repo();

    if (violations.length === 0) {
      if (hasLabel) {
        await context.octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number: item.number,
          name: label,
        });
        log.info(`Removed "${label}" from #${item.number}`);
      }

      return;
    }

    const comments = await context.octokit.paginate(context.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: item.number,
      per_page: 100,
    });
    const priorComment = findCarsonComment(comments, {
      marker: COMMENT_MARKER,
      isBotAuthored: (c) => c.user?.type === 'Bot',
    });

    if (priorComment === undefined) {
      const body = `${interpolate(messageTemplate, {
        user: item.user,
        type: typeLabel(kind),
        number: item.number,
        title: item.title,
        label,
        violations: renderViolations(violations),
      })}\n\n${COMMENT_MARKER}`;

      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: item.number,
        body,
      });
      log.info(`Posted template-enforcer comment on #${item.number}`);
    }

    if (!hasLabel) {
      await context.octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: item.number,
        labels: [label],
      });
      log.info(`Added "${label}" to #${item.number}`);
    }
  }
}
