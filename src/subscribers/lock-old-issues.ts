import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import { interpolate } from '../template.js';
import type { Probot } from 'probot';
import { Subscriber } from '../subscriber.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const;

const Settings = z.object({
  days: z.number().int().positive().optional(),
  reason: z.enum(LOCK_REASONS).optional(),
  exempt_labels: z.array(z.string()).optional(),
  comment: z.string().optional(),
});

const DEFAULT_DAYS = 90;
const DEFAULT_REASON: (typeof LOCK_REASONS)[number] = 'resolved';
const MS_PER_DAY = 24 * 60 * 60 * 1000; // 86,400,000 ms

export class LockOldIssuesSubscriber extends Subscriber {
  public readonly id = 'lock-old-issues';
  public readonly description = 'Locks closed issues that have been inactive past a configurable threshold.';

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public register(_probot: Probot): void {}

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    registrar.on(async (context) => {
      await this.#run(context);
    });
  }

  async #run(context: ScheduledContext): Promise<void> {
    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    const settings = subscriberSettings(config, this.id, Settings) ?? {};
    const days = settings.days ?? DEFAULT_DAYS;
    const reason = settings.reason ?? DEFAULT_REASON;
    const exemptLabels = new Set(settings.exempt_labels ?? []);
    const cutoff = Date.now() - days * MS_PER_DAY;
    const { owner, repo } = context.repo();

    const issues = await context.octokit.paginate(context.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'closed',
      per_page: 100,
    });

    let locked = 0;

    for (const issue of issues) {
      if (issue.pull_request !== undefined) {
        continue;
      }

      if (issue.locked) {
        continue;
      }

      if (issue.closed_at === null) {
        continue;
      }

      if (new Date(issue.closed_at).getTime() > cutoff) {
        continue;
      }

      const labelNames = issue.labels.map((label) => (typeof label === 'string' ? label : label.name));

      if (labelNames.some((name) => name !== undefined && exemptLabels.has(name))) {
        continue;
      }

      if (settings.comment !== undefined) {
        const vars: Record<string, string | number> = {
          number: issue.number,
          repo,
          days,
        };

        if (issue.user !== null) {
          vars['user'] = issue.user.login;
        }

        await context.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issue.number,
          body: interpolate(settings.comment, vars),
        });
      }

      await context.octokit.rest.issues.lock({
        owner,
        repo,
        issue_number: issue.number,
        lock_reason: reason,
      });
      locked += 1;
    }

    context.log.info(`lock-old-issues: locked ${locked} issue(s) older than ${days} day(s) in ${owner}/${repo}`);
  }
}
