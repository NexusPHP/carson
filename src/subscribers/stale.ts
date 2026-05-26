import type { Context, Probot } from 'probot';
import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import { interpolate } from '../template.js';
import { Subscriber } from '../subscriber.js';
import { subscriberSettings } from '../configuration/schema.js';
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

const MINIMIZE_MUTATION = `mutation($subjectId: ID!) {
  minimizeComment(input: { subjectId: $subjectId, classifier: OUTDATED }) {
    minimizedComment { isMinimized }
  }
}`;

export class StaleSubscriber extends Subscriber {
  public readonly id = 'stale';
  public readonly description = 'Marks inactive issues and pull requests as stale, then closes them after a further grace period.';

  public register(probot: Probot): void {
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
    if (context.isBot) {
      return;
    }

    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    const settings = subscriberSettings(config, this.id, Settings) ?? {};
    const staleLabel = settings.stale_label ?? DEFAULT_STALE_LABEL;
    const labelNames = (rawLabels ?? [])
      .map((label) => label.name)
      .filter((name): name is string => name !== undefined);

    if (!labelNames.includes(staleLabel)) {
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
    const stalePost = comments.find((c) => c.body?.includes(COMMENT_MARKER) === true);

    if (stalePost !== undefined) {
      await context.octokit.graphql(MINIMIZE_MUTATION, { subjectId: stalePost.node_id });
      context.log.info(`stale: minimized stale notice on #${issueNumber}`);
    }

    context.log.info(`stale: removed "${staleLabel}" from #${issueNumber} after activity`);
  }

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
    const daysUntilStale = settings.days_until_stale ?? DEFAULT_DAYS_STALE;
    const daysUntilClose = settings.days_until_close ?? DEFAULT_DAYS_CLOSE;
    const staleLabel = settings.stale_label ?? DEFAULT_STALE_LABEL;
    const staleMessage = settings.stale_message ?? DEFAULT_STALE_MESSAGE;
    const closeMessage = settings.close_message ?? DEFAULT_CLOSE_MESSAGE;
    const exemptLabels = new Set(settings.exempt_labels ?? []);
    const staleCutoff = Date.now() - daysUntilStale * MS_PER_DAY;
    const closeCutoff = Date.now() - daysUntilClose * MS_PER_DAY;
    const { owner, repo } = context.repo();

    const items = await context.octokit.paginate(context.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });

    let staled = 0;
    let closed = 0;

    for (const item of items) {
      const labelNames = item.labels
        .map((label) => (typeof label === 'string' ? label : label.name))
        .filter((name): name is string => name !== undefined);

      if (labelNames.some((name) => exemptLabels.has(name))) {
        continue;
      }

      const updatedAt = new Date(item.updated_at).getTime();
      const isStale = labelNames.includes(staleLabel);
      const kind = item.pull_request === undefined ? 'issue' : 'pull request';

      const vars: Record<string, string | number> = {
        number: item.number,
        repo,
        title: item.title,
        type: kind,
        days_inactive: daysUntilStale,
        days_until_close: daysUntilClose,
      };

      if (item.user !== null) {
        vars['user'] = item.user.login;
      }

      if (isStale) {
        if (updatedAt < closeCutoff) {
          await context.octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: item.number,
            body: interpolate(closeMessage, vars),
          });
          await context.octokit.rest.issues.update({
            owner,
            repo,
            issue_number: item.number,
            state: 'closed',
          });
          closed += 1;
        }
      } else if (updatedAt < staleCutoff) {
        await context.octokit.rest.issues.addLabels({
          owner,
          repo,
          issue_number: item.number,
          labels: [staleLabel],
        });
        await context.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: item.number,
          body: `${interpolate(staleMessage, vars)}\n\n${COMMENT_MARKER}`,
        });
        staled += 1;
      }
    }

    context.log.info(`stale: marked ${staled} stale, closed ${closed} in ${owner}/${repo}`);
  }
}
