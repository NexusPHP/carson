import type { Context, Probot } from 'probot';
import { interpolate, itemRef, pluralize } from '../template.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { forEachConcurrent } from '../concurrency.js';
import { labelNames } from '../github/labels.js';
import { searchTimestamp } from '../github/search.js';
import { z } from 'zod';

const Overridable = {
  days_until_close: z.number().int().positive().optional(),
  close_message: z.string().optional(),
  exempt_labels: z.array(z.string()).optional(),
  unlabel_on_response: z.boolean().optional(),
};

const Rule = z.object({
  label: z.string().min(1),
  only: z.enum(['issues', 'pull_requests']).optional(),
  ...Overridable,
});

const Settings = z.object({
  label: z.string().optional(),
  ...Overridable,
  rules: z.array(Rule).optional(),
});

type Settings = z.infer<typeof Settings>;

interface ResolvedRule {
  label: string;
  only: 'issues' | 'pull_requests' | undefined;
  days: number;
  message: string;
  exempt: ReadonlySet<string>;
  unlabelOnResponse: boolean;
}

interface Responded {
  number: number;
  isPr: boolean;
  isOpen: boolean;
  author: string | undefined;
  labels: readonly string[];
}

const DEFAULT_LABEL = 'needs-info';
const DEFAULT_DAYS_UNTIL_CLOSE = 14;
const DEFAULT_CLOSE_MESSAGE = 'Closing this {{type}}: no response for {{days_until_close}} days after information was requested. Comment with the requested details and it can be reopened.';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;
const SCOPES = { issues: ' is:issue', pull_requests: ' is:pr' } as const;

const COMMENT_EVENTS = ['issue_comment.created'] satisfies EmitterWebhookEventName[];
const PR_RESPONSE_EVENTS = ['pull_request.synchronize', 'pull_request_review_comment.created'] satisfies EmitterWebhookEventName[];

type ResponseContext = Context<(typeof COMMENT_EVENTS)[number] | (typeof PR_RESPONSE_EVENTS)[number]>;

const resolveRules = (settings: Settings): ResolvedRule[] => {
  const rules: z.infer<typeof Rule>[] = settings.rules ?? [{ label: settings.label ?? DEFAULT_LABEL }];

  return rules.map((rule) => ({
    label: rule.label,
    only: rule.only,
    days: rule.days_until_close ?? settings.days_until_close ?? DEFAULT_DAYS_UNTIL_CLOSE,
    message: rule.close_message ?? settings.close_message ?? DEFAULT_CLOSE_MESSAGE,
    exempt: new Set(rule.exempt_labels ?? settings.exempt_labels ?? []),
    unlabelOnResponse: rule.unlabel_on_response ?? settings.unlabel_on_response ?? false,
  }));
};

const ruleConflicts = (settings: Settings): string[] => {
  if (settings.rules === undefined) {
    return [];
  }

  const conflicts: string[] = [];
  const seen = new Set<string>();

  if (settings.label !== undefined) {
    conflicts.push('"label" cannot be combined with "rules"');
  }

  for (const rule of settings.rules) {
    const key = rule.label.toLowerCase();

    if (seen.has(key)) {
      conflicts.push(`more than one rule for label "${rule.label}"`);
    }

    seen.add(key);

    if ((rule.exempt_labels ?? settings.exempt_labels ?? []).some((l) => l.toLowerCase() === key)) {
      conflicts.push(`rule "${rule.label}" exempts its own label`);
    }
  }

  return conflicts;
};

export class NoResponseCloserSubscriber extends Subscriber {
  public readonly id = 'no-response-closer';
  public readonly description = 'Closes issues and pull requests carrying a configurable label whose activity has been stale past a configurable threshold.';
  public readonly requiredPermissions: RequiredPermissions = {
    issues: 'write',
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(COMMENT_EVENTS, async (context): Promise<void> => {
      const issue = context.payload.issue;

      await this.#handleResponse(context, {
        number: issue.number,
        isPr: issue.pull_request !== undefined,
        isOpen: issue.state === 'open',
        author: issue.user.login,
        labels: labelNames(issue.labels),
      });
    });

    probot.on(PR_RESPONSE_EVENTS, async (context): Promise<void> => {
      const pr = context.payload.pull_request;

      await this.#handleResponse(context, {
        number: pr.number,
        isPr: true,
        isOpen: pr.state === 'open',
        author: pr.user?.login,
        labels: labelNames(pr.labels),
      });
    });
  }

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    registrar.on(async (context) => {
      await this.#run(context);
    });
  }

  async #handleResponse(context: ResponseContext, item: Responded): Promise<void> {
    if (context.isBot || !item.isOpen || item.author !== context.payload.sender.login) {
      return;
    }

    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null || ruleConflicts(enabled.settings).length > 0) {
      return;
    }

    const carried = new Set(item.labels.map((name) => name.toLowerCase()));
    const kind = item.isPr ? 'pull_requests' : 'issues';
    const labels = resolveRules(enabled.settings)
      .filter((rule) => rule.unlabelOnResponse && (rule.only ?? kind) === kind && carried.has(rule.label.toLowerCase()))
      .map((rule) => rule.label);

    if (labels.length === 0) {
      return;
    }

    if (await this.dispatch('unlabel', context, { number: item.number, labels })) {
      const names = labels.map((label) => `"${label}"`).join(', ');

      this.log().info(`Removed ${names} from ${itemRef(item.isPr, item.number)} after a response from its author`);
    }
  }

  async #run(scheduled: ScheduledContext): Promise<void> {
    const enabled = await this.loadEnabledSettings(scheduled, Settings);

    if (enabled === null) {
      return;
    }

    const conflicts = ruleConflicts(enabled.settings);

    if (conflicts.length > 0) {
      this.log().warn(`Skipping the run, settings conflict: ${conflicts.join(', ')}`);

      return;
    }

    const closed = new Set<number>();

    for (const rule of resolveRules(enabled.settings)) {
      await this.#runRule(scheduled, rule, closed);
    }
  }

  // The search index lags a close, so an item closed by an earlier rule can come back as open.
  async #runRule(scheduled: ScheduledContext, rule: ResolvedRule, closed: Set<number>): Promise<void> {
    const cutoff = Date.now() - rule.days * MS_PER_DAY;
    const { owner, repo } = scheduled.repo();

    const items = await scheduled.octokit.paginate(scheduled.octokit.rest.search.issuesAndPullRequests, {
      q: `repo:${owner}/${repo} is:open${rule.only === undefined ? '' : SCOPES[rule.only]} label:"${rule.label}" updated:<${searchTimestamp(cutoff)}`,
      advanced_search: 'true',
      sort: 'updated',
      order: 'asc',
      per_page: 100,
    });

    let count = 0;
    const log = this.log();

    log.debug(`Found ${pluralize(items.length, 'candidate item')} labeled "${rule.label}"`);

    await forEachConcurrent(items, CONCURRENCY, async (item) => {
      const isPr = item.pull_request !== undefined;
      const ref = itemRef(isPr, item.number, true);

      if (closed.has(item.number)) {
        log.debug(`${ref}: Closed by an earlier rule, skipping`);

        return;
      }

      if (labelNames(item.labels).some((name) => rule.exempt.has(name))) {
        log.debug(`${ref}: Exempt label, skipping`);

        return;
      }

      if (new Date(item.updated_at).getTime() > cutoff) {
        log.debug(`${ref}: Recent activity, skipping`);

        return;
      }

      const context: Record<string, string | number> = {
        number: item.number,
        repo,
        title: item.title,
        type: isPr ? 'pull request' : 'issue',
        label: rule.label,
        days_until_close: rule.days,
      };

      if (item.user !== null) {
        context['user'] = item.user.login;
      }

      await scheduled.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: item.number,
        body: interpolate(rule.message, context),
      });

      await scheduled.octokit.rest.issues.update({
        owner,
        repo,
        issue_number: item.number,
        state: 'closed',
        ...(isPr ? {} : { state_reason: 'not_planned' as const }),
      });

      log.debug(`${ref}: Closed`);
      closed.add(item.number);
      count += 1;
    });

    log.info(`Closed ${pluralize(count, 'item')} labeled "${rule.label}" with no activity for ${pluralize(rule.days, 'day')}`);
  }
}
