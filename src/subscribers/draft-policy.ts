import type { Context, Probot } from 'probot';
import { findNotice, fromRestComment, isBotComment } from '../github/notices.js';
import { interpolate, pluralize, type TemplateContext } from '../template.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { forEachConcurrent } from '../concurrency.js';
import { z } from 'zod';

const Settings = z.object({
  message: z.string().optional(),
  hours_until_close: z.number().int().nonnegative().optional(),
  close_message: z.string().optional(),
});

const DEFAULT_HOURS_UNTIL_CLOSE = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const CONCURRENCY = 5;

const DEFAULT_MESSAGE = `Hey @{{user}}, thanks for the pull request!

This repository does not keep draft pull requests open. A pull request does not have to be finished to be reviewed, so please mark it "Ready for review" when you would like a first look, or close it and open a new one when you are done.`;

const DEFAULT_CLOSE_MESSAGE = `Closing this draft pull request as it has stayed in draft for more than {{hours}} hours. Feel free to open a new one when it is ready for review.`;

const PR_EVENTS = [
  'pull_request.opened',
  'pull_request.reopened',
  'pull_request.converted_to_draft',
  'pull_request.ready_for_review',
] satisfies EmitterWebhookEventName[];

type DraftPolicyContext = Context<(typeof PR_EVENTS)[number]>;

export class DraftPolicySubscriber extends Subscriber {
  public readonly id = 'draft-policy';
  public readonly description = 'Comments on draft pull requests and closes those still in draft after a grace period.';
  public readonly requiredPermissions: RequiredPermissions = {
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context);
    });
  }

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    registrar.on(async (context) => {
      await this.#run(context);
    });
  }

  async #handle(context: DraftPolicyContext): Promise<void> {
    const log = this.log();
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const pr = context.payload.pull_request;
    const { owner, repo } = context.repo();

    if (context.payload.action === 'ready_for_review') {
      const comments = await context.octokit.paginate(context.octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: pr.number,
        per_page: 100,
      });
      const notice = findNotice(comments, this.id, isBotComment);

      if (notice !== undefined) {
        await this.resolveNotice(context, pr.number, fromRestComment(notice), 'RESOLVED');
        log.info(`Resolved draft notice on PR #${pr.number}`);
      }

      return;
    }

    if (pr.draft !== true) {
      return;
    }

    const templateContext: TemplateContext = {
      user: pr.user.login,
      repo: context.payload.repository.name,
      number: pr.number,
    };

    this.notice(context, pr.number, interpolate(enabled.settings.message ?? DEFAULT_MESSAGE, templateContext));
    log.info(`Posted draft notice on PR #${pr.number}`);
  }

  async #run(scheduled: ScheduledContext): Promise<void> {
    const log = this.log();
    const enabled = await this.loadEnabledSettings(scheduled, Settings);

    if (enabled === null) {
      return;
    }

    const hours = enabled.settings.hours_until_close ?? DEFAULT_HOURS_UNTIL_CLOSE;

    if (hours === 0) {
      log.debug('hours_until_close is 0, drafts are never closed');

      return;
    }

    const closeMessage = enabled.settings.close_message ?? DEFAULT_CLOSE_MESSAGE;
    const cutoff = Date.now() - hours * MS_PER_HOUR;
    const { owner, repo } = scheduled.repo();
    const drafts = await scheduled.octokit.paginate(scheduled.octokit.rest.search.issuesAndPullRequests, {
      q: `repo:${owner}/${repo} is:pr is:open draft:true`,
      advanced_search: 'true',
      per_page: 100,
    });
    let closed = 0;

    await forEachConcurrent(drafts, CONCURRENCY, async (item) => {
      if (new Date(item.created_at).getTime() >= cutoff) {
        log.debug(`#${item.number}: opened within the grace period, skipping`);

        return;
      }

      const comments = await scheduled.octokit.paginate(scheduled.octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: item.number,
        per_page: 100,
      });
      const notice = findNotice(comments, this.id, isBotComment);

      if (notice === undefined || new Date(notice.created_at).getTime() >= cutoff) {
        log.debug(`#${item.number}: ${notice === undefined ? 'no draft notice' : 'within grace period'}, skipping`);

        return;
      }

      const templateContext: TemplateContext = {
        repo,
        number: item.number,
        hours,
        ...(item.user === null ? {} : { user: item.user.login }),
      };

      await scheduled.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: item.number,
        body: interpolate(closeMessage, templateContext),
      });
      await scheduled.octokit.rest.issues.update({ owner, repo, issue_number: item.number, state: 'closed' });
      log.debug(`#${item.number}: Closed (draft past grace period)`);
      closed += 1;
    });

    log.info(`Closed ${pluralize(closed, 'draft pull request')}`);
  }
}
