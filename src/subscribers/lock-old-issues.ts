import type { ActionContext, ActionRegistrar } from '../actions.js';
import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import { forEachConcurrent } from '../concurrency.js';
import { interpolate } from '../template.js';
import { labelNames } from '../github/labels.js';
import { searchTimestamp } from '../github/search.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const LOCK_REASONS = ['off-topic', 'too heated', 'resolved', 'spam'] as const;

const Settings = z.object({
  days: z.number().int().positive().optional(),
  reason: z.enum(LOCK_REASONS).optional(),
  exempt_labels: z.array(z.string()).optional(),
  comment: z.string().optional(),
  lock_on_labels: z.array(z.string().min(1)).optional(),
});

const DEFAULT_DAYS = 90;
const DEFAULT_REASON: (typeof LOCK_REASONS)[number] = 'resolved';
const DEFAULT_COMMENT = 'This issue has been locked after {{days}} days of inactivity since it was closed. Please open a new issue if the problem persists.';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;

export class LockOldIssuesSubscriber extends Subscriber {
  public readonly id = 'lock-old-issues';
  public readonly description = 'Locks closed issues that have been inactive past a configurable threshold.';
  public readonly requiredPermissions: RequiredPermissions = { issues: 'write' };

  public override register(probot: Probot): void {
    probot.on('issues.labeled', async (context: Context<'issues.labeled'>): Promise<void> => {
      await this.#handleLabeled(context);
    });
  }

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    registrar.on(async (context) => {
      await this.#run(context);
    });
  }

  public override registerActions(registrar: ActionRegistrar): void {
    registrar.on('lock', this.id, async (context, request) => await this.#lock(context, request.number));
  }

  // The requester has already commented and already decided the sender is
  // legitimate, so this posts nothing and applies no bot-sender guard.
  async #lock(context: ActionContext, number: number): Promise<boolean> {
    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return false;
    }

    const settings = subscriberSettings(config, this.id, Settings, this.log(context));

    await this.#applyLock(context, number, settings?.reason ?? DEFAULT_REASON);
    this.log(context).info(`Locked #${number} on request`);

    return true;
  }

  // A label applied by another bot (auto-labeler, say) must still lock, so
  // this applies no bot-sender guard either.
  async #handleLabeled(context: Context<'issues.labeled'>): Promise<void> {
    const log = this.log(context);
    const issue = context.payload.issue;
    const label = context.payload.label?.name;

    if (label === undefined || issue.locked === true) {
      return;
    }

    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    const settings = subscriberSettings(config, this.id, Settings, log);

    if (!(settings?.lock_on_labels ?? []).includes(label)) {
      log.debug(`#${issue.number}: Label "${label}" not in lock_on_labels, skipping`);
      return;
    }

    await this.#applyLock(context, issue.number, settings?.reason ?? DEFAULT_REASON);
    log.info(`Locked #${issue.number} on label "${label}"`);
  }

  async #applyLock(context: ActionContext, number: number, reason: (typeof LOCK_REASONS)[number]): Promise<void> {
    const { owner, repo } = context.repo();

    await context.octokit.rest.issues.lock({
      owner,
      repo,
      issue_number: number,
      lock_reason: reason,
    });
  }

  async #run(scheduled: ScheduledContext): Promise<void> {
    const enabled = await this.loadEnabledSettings(scheduled, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const days = settings.days ?? DEFAULT_DAYS;
    const reason = settings.reason ?? DEFAULT_REASON;
    const comment = settings.comment ?? DEFAULT_COMMENT;
    const exemptLabels = new Set(settings.exempt_labels ?? []);
    const cutoff = Date.now() - days * MS_PER_DAY;
    const { owner, repo } = scheduled.repo();

    const issues = await scheduled.octokit.paginate(scheduled.octokit.rest.search.issuesAndPullRequests, {
      q: `repo:${owner}/${repo} is:issue is:closed is:unlocked closed:<${searchTimestamp(cutoff)}`,
      advanced_search: 'true',
      sort: 'created',
      order: 'asc',
      per_page: 100,
    });

    let locked = 0;
    const log = this.log(scheduled);

    log.debug(`Scanning ${issues.length} candidate issue(s)`);

    await forEachConcurrent(issues, CONCURRENCY, async (issue) => {
      if (issue.pull_request !== undefined) {
        log.debug(`#${issue.number}: Pull request, skipping`);
        return;
      }

      if (issue.locked) {
        log.debug(`#${issue.number}: Already locked, skipping`);
        return;
      }

      if (issue.closed_at === null) {
        log.debug(`#${issue.number}: No closed_at, skipping`);
        return;
      }

      if (new Date(issue.closed_at).getTime() > cutoff) {
        log.debug(`#${issue.number}: Closed too recently, skipping`);
        return;
      }

      if (labelNames(issue.labels).some((name) => exemptLabels.has(name))) {
        log.debug(`#${issue.number}: Exempt label, skipping`);
        return;
      }

      const context: Record<string, string | number> = {
        number: issue.number,
        repo,
        days,
      };

      if (issue.user !== null) {
        context['user'] = issue.user.login;
      }

      await scheduled.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: interpolate(comment, context),
      });

      await scheduled.octokit.rest.issues.lock({
        owner,
        repo,
        issue_number: issue.number,
        lock_reason: reason,
      });
      log.debug(`#${issue.number}: Locked`);
      locked += 1;
    });

    log.info(`Locked ${locked} issue(s) older than ${days} day(s)`);
  }
}
