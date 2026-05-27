import type { Context, Probot } from 'probot';
import { findCarsonComment, minimizeComment } from '../github/comments.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import { forEachConcurrent } from '../concurrency.js';
import { interpolate } from '../template.js';
import { labelNames } from '../github/labels.js';
import { z } from 'zod';

const Settings = z.object({
  days_until_stale: z.number().int().positive().optional(),
  days_until_close: z.number().int().positive().optional(),
  stale_label: z.string().optional(),
  stale_message: z.string().optional(),
  close_message: z.string().optional(),
  exempt_labels: z.array(z.string()).optional(),
});

const DEFAULT_DAYS_STALE = 60;
const DEFAULT_DAYS_CLOSE = 7;
const DEFAULT_STALE_LABEL = 'stale';
const DEFAULT_STALE_MESSAGE = 'This {{type}} has been inactive for {{days_inactive}} days. It will be closed in {{days_until_close}} days without further activity.';
const DEFAULT_CLOSE_MESSAGE = 'Closing this {{type}} due to extended inactivity.';
const COMMENT_MARKER = '<!-- carson:stale -->';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;

export class StaleSubscriber extends Subscriber {
  public readonly id = 'stale';
  public readonly description = 'Marks inactive issues and pull requests as stale, then closes them after a further grace period.';
  public readonly requiredPermissions: RequiredPermissions = { issues: 'write', pull_requests: 'write' };

  public override register(probot: Probot): void {
    probot.on(['issue_comment.created', 'issues.edited'], async (context): Promise<void> => {
      const ctx = context as Context<'issue_comment.created' | 'issues.edited'>;
      await this.#processActivity(ctx, ctx.payload.issue.number, ctx.payload.issue.labels);
    });

    probot.on(['pull_request.synchronize', 'pull_request.edited'], async (context): Promise<void> => {
      const ctx = context as Context<'pull_request.synchronize' | 'pull_request.edited'>;
      await this.#processActivity(ctx, ctx.payload.pull_request.number, ctx.payload.pull_request.labels);
    });

    probot.on('pull_request_review.submitted', async (context): Promise<void> => {
      await this.#processActivity(
        context,
        context.payload.pull_request.number,
        context.payload.pull_request.labels,
      );
    });
  }

  async #processActivity(
    context: Context<'issue_comment.created' | 'issues.edited' | 'pull_request.synchronize' | 'pull_request.edited' | 'pull_request_review.submitted'>,
    issueNumber: number,
    rawLabels: { name?: string }[] | undefined,
  ): Promise<void> {
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const staleLabel = settings.stale_label ?? DEFAULT_STALE_LABEL;

    if (!labelNames(rawLabels).includes(staleLabel)) {
      return;
    }

    const { owner, repo } = context.repo();
    await context.octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: staleLabel,
    });

    const comments = await context.octokit.paginate(context.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const stalePost = findCarsonComment(comments, {
      marker: COMMENT_MARKER,
      isBotAuthored: (c) => c.user?.type === 'Bot',
    });

    const log = this.log(context);

    if (stalePost !== undefined) {
      await minimizeComment(context.octokit, stalePost.node_id, 'OUTDATED');
      log.info(`Minimized stale notice on #${issueNumber}`);
    }

    log.info(`Removed "${staleLabel}" from #${issueNumber} after activity`);
  }

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    registrar.on(async (context) => {
      await this.#run(context);
    });
  }

  async #run(scheduled: ScheduledContext): Promise<void> {
    const enabled = await this.loadEnabledSettings(scheduled, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const daysUntilStale = settings.days_until_stale ?? DEFAULT_DAYS_STALE;
    const daysUntilClose = settings.days_until_close ?? DEFAULT_DAYS_CLOSE;
    const staleLabel = settings.stale_label ?? DEFAULT_STALE_LABEL;
    const staleMessage = settings.stale_message ?? DEFAULT_STALE_MESSAGE;
    const closeMessage = settings.close_message ?? DEFAULT_CLOSE_MESSAGE;
    const exemptLabels = new Set(settings.exempt_labels ?? []);
    const staleCutoff = Date.now() - daysUntilStale * MS_PER_DAY;
    const closeCutoff = Date.now() - daysUntilClose * MS_PER_DAY;
    const { owner, repo } = scheduled.repo();

    const items = await scheduled.octokit.paginate(scheduled.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });

    let staled = 0;
    let closed = 0;
    const log = this.log(scheduled);

    log.debug(`Scanning ${items.length} open item(s)`);

    await forEachConcurrent(items, CONCURRENCY, async (item) => {
      const names = labelNames(item.labels);

      if (names.some((name) => exemptLabels.has(name))) {
        log.debug(`#${item.number}: Exempt label, skipping`);
        return;
      }

      const updatedAt = new Date(item.updated_at).getTime();
      const isStale = names.includes(staleLabel);
      const kind = item.pull_request === undefined ? 'issue' : 'pull request';

      const context: Record<string, string | number> = {
        number: item.number,
        repo,
        title: item.title,
        type: kind,
        days_inactive: daysUntilStale,
        days_until_close: daysUntilClose,
      };

      if (item.user !== null) {
        context['user'] = item.user.login;
      }

      if (isStale) {
        if (updatedAt < closeCutoff) {
          await scheduled.octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: item.number,
            body: interpolate(closeMessage, context),
          });
          await scheduled.octokit.rest.issues.update({
            owner,
            repo,
            issue_number: item.number,
            state: 'closed',
          });
          log.debug(`#${item.number}: Closed (stale and past close cutoff)`);
          closed += 1;
        } else {
          log.debug(`#${item.number}: Stale but within grace period`);
        }
      } else if (updatedAt < staleCutoff) {
        await scheduled.octokit.rest.issues.addLabels({
          owner,
          repo,
          issue_number: item.number,
          labels: [staleLabel],
        });
        await scheduled.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: item.number,
          body: `${interpolate(staleMessage, context)}\n\n${COMMENT_MARKER}`,
        });
        log.debug(`#${item.number}: Marked stale`);
        staled += 1;
      } else {
        log.debug(`#${item.number}: Not yet stale`);
      }
    });

    log.info(`Marked ${staled} stale, closed ${closed}`);
  }
}
