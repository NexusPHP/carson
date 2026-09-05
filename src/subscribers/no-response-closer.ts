import { interpolate, pluralize } from '../template.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import { forEachConcurrent } from '../concurrency.js';
import { labelNames } from '../github/labels.js';
import { searchTimestamp } from '../github/search.js';
import { z } from 'zod';

const Settings = z.object({
  label: z.string().optional(),
  days_until_close: z.number().int().positive().optional(),
  close_message: z.string().optional(),
  exempt_labels: z.array(z.string()).optional(),
});

const DEFAULT_LABEL = 'needs-info';
const DEFAULT_DAYS_UNTIL_CLOSE = 14;
const DEFAULT_CLOSE_MESSAGE = 'Closing this {{type}}: no response for {{days_until_close}} days after information was requested. Comment with the requested details and it can be reopened.';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;

export class NoResponseCloserSubscriber extends Subscriber {
  public readonly id = 'no-response-closer';
  public readonly description = 'Closes issues and pull requests carrying a configurable label whose activity has been stale past a configurable threshold.';
  public readonly requiredPermissions: RequiredPermissions = {
    issues: 'write',
    pull_requests: 'write',
  };

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
    const label = settings.label ?? DEFAULT_LABEL;
    const daysUntilClose = settings.days_until_close ?? DEFAULT_DAYS_UNTIL_CLOSE;
    const closeMessage = settings.close_message ?? DEFAULT_CLOSE_MESSAGE;
    const exemptLabels = new Set(settings.exempt_labels ?? []);
    const cutoff = Date.now() - daysUntilClose * MS_PER_DAY;
    const { owner, repo } = scheduled.repo();

    const items = await scheduled.octokit.paginate(scheduled.octokit.rest.search.issuesAndPullRequests, {
      q: `repo:${owner}/${repo} is:open label:"${label}" updated:<${searchTimestamp(cutoff)}`,
      advanced_search: 'true',
      sort: 'updated',
      order: 'asc',
      per_page: 100,
    });

    let closed = 0;
    const log = this.log(scheduled);

    log.debug(`Scanning ${pluralize(items.length, 'candidate item')} labeled "${label}"`);

    await forEachConcurrent(items, CONCURRENCY, async (item) => {
      if (labelNames(item.labels).some((name) => exemptLabels.has(name))) {
        log.debug(`#${item.number}: Exempt label, skipping`);

        return;
      }

      if (new Date(item.updated_at).getTime() > cutoff) {
        log.debug(`#${item.number}: Recent activity, skipping`);

        return;
      }

      const isPr = item.pull_request !== undefined;

      const context: Record<string, string | number> = {
        number: item.number,
        repo,
        title: item.title,
        type: isPr ? 'pull request' : 'issue',
        days_until_close: daysUntilClose,
      };

      if (item.user !== null) {
        context['user'] = item.user.login;
      }

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
        ...(isPr ? {} : { state_reason: 'not_planned' as const }),
      });

      log.debug(`#${item.number}: Closed`);
      closed += 1;
    });

    log.info(`Closed ${pluralize(closed, 'item')} labeled "${label}" with no activity for ${pluralize(daysUntilClose, 'day')}`);
  }
}
