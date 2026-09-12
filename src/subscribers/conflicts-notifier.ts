import type { Context, Probot } from 'probot';
import { findNotice, type FoundNotice, isBotNode } from '../github/notices.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { CarsonConfig } from '../configuration/schema.js';
import { forEachConcurrent } from '../concurrency.js';
import { interpolate } from '../template.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const Settings = z.object({
  message: z.string().optional(),
  label: z.string().min(1).optional(),
});

type ParsedSettings = z.infer<typeof Settings>;

const DEFAULT_MESSAGE = '@{{user}} this PR has merge conflicts with `{{base}}`. Please rebase or resolve them.';
const CONCURRENCY = 5;

type PrEvent = 'pull_request.opened' | 'pull_request.synchronize' | 'pull_request.reopened' | 'pull_request.edited';
type SupportedEvent = PrEvent | 'push';
type SubscriberContext = Context<SupportedEvent>;

const PR_EVENTS: PrEvent[] = [
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
  'pull_request.edited',
];

interface CommentsQueryResponse {
  repository: {
    pullRequest: {
      comments: {
        nodes: {
          id: string;
          fullDatabaseId: string;
          body: string;
          isMinimized: boolean;
          author: { __typename: string } | null;
        }[];
      };
    };
  };
}

// Read the most recent 100 comments so Carson's marker comment is preserved
// at the tail of a long thread. The marker is always at the end of the body
// and Carson posts at most once per PR.
const COMMENTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(last: 100) {
        nodes {
          id
          fullDatabaseId
          body
          isMinimized
          author {
            __typename
          }
        }
      }
    }
  }
}`;

export class ConflictsNotifierSubscriber extends Subscriber {
  public readonly id = 'conflicts-notifier';
  public readonly description = 'Comments on PRs with merge conflicts and marks the comment resolved when fixed.';
  public readonly requiredPermissions: RequiredPermissions = {
    issues: 'write',
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handlePrEvent(context as Context<PrEvent>);
    });

    probot.on('push', async (context): Promise<void> => {
      await this.#handlePushEvent(context as Context<'push'>);
    });
  }

  async #handlePrEvent(context: Context<PrEvent>): Promise<void> {
    if (context.payload.action === 'edited' && context.payload.changes.base === undefined) {
      return;
    }

    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    await this.#checkPr(context, context.payload.pull_request.number, config);
  }

  async #handlePushEvent(context: Context<'push'>): Promise<void> {
    const ref = context.payload.ref;

    if (!ref.startsWith('refs/heads/')) {
      return;
    }

    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    const branch = ref.slice('refs/heads/'.length);
    const { owner, repo } = context.repo();
    const prs = await context.octokit.paginate(context.octokit.rest.pulls.list, {
      owner,
      repo,
      base: branch,
      state: 'open',
      per_page: 100,
    });

    await forEachConcurrent(prs, CONCURRENCY, async (pr) => {
      await this.#checkPr(context, pr.number, config);
    });
  }

  async #checkPr(context: SubscriberContext, prNumber: number, config: CarsonConfig): Promise<void> {
    const { owner, repo } = context.repo();
    const { data: pr } = await context.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (pr.mergeable === null) {
      this.log().debug(`PR #${prNumber}: mergeable not yet computed, skipping`);
      return;
    }

    if (pr.user === null) {
      return;
    }

    const hasConflict = pr.mergeable === false;
    const settings = subscriberSettings(config, this.id, Settings, this.log()) ?? {};
    const existing = await this.#findExistingComment(context, prNumber);

    if (hasConflict) {
      await this.#handleConflict(context, pr, settings, existing);
    } else {
      await this.#handleNoConflict(context, prNumber, existing);
    }

    if (settings.label !== undefined) {
      await this.#syncLabel(context, pr.number, pr.labels.some((l) => l.name === settings.label), hasConflict, settings.label);
    }
  }

  // Labeling is delegated to auto-labeler through the action router.
  async #syncLabel(
    context: SubscriberContext,
    prNumber: number,
    hasLabel: boolean,
    hasConflict: boolean,
    label: string,
  ): Promise<void> {
    if (hasConflict && !hasLabel) {
      await this.dispatch('label', context, { number: prNumber, labels: [label] });
    } else if (!hasConflict && hasLabel) {
      await this.dispatch('unlabel', context, { number: prNumber, labels: [label] });
    }
  }

  async #handleConflict(
    context: SubscriberContext,
    pr: {
      number: number;
      title: string;
      user: { login: string };
      base: { ref: string };
    },
    settings: ParsedSettings,
    existing: FoundNotice | null,
  ): Promise<void> {
    const { repo } = context.repo();

    if (existing === null) {
      const message = interpolate(settings.message ?? DEFAULT_MESSAGE, {
        user: pr.user.login,
        repo,
        number: pr.number,
        title: pr.title,
        base: pr.base.ref,
      });

      this.notice(context, pr.number, message);
      this.log().info(`Posted conflict notice on PR #${pr.number}`);
      return;
    }

    if (this.isNoticeResolved(existing)) {
      await this.reopenNotice(context, pr.number, existing);
      this.log().info(`Reopened conflict notice on PR #${pr.number}`);
    }
  }

  async #handleNoConflict(
    context: SubscriberContext,
    prNumber: number,
    existing: FoundNotice | null,
  ): Promise<void> {
    const log = this.log();

    if (existing === null) {
      log.debug(`PR #${prNumber}: No conflict, no prior notice, nothing to do`);
      return;
    }

    if (this.isNoticeResolved(existing)) {
      log.debug(`PR #${prNumber}: No conflict, prior notice already minimized`);
      return;
    }

    await this.resolveNotice(context, prNumber, existing, 'RESOLVED');
    log.info(`Resolved conflict notice on PR #${prNumber}`);
  }

  async #findExistingComment(context: SubscriberContext, prNumber: number): Promise<FoundNotice | null> {
    const { owner, repo } = context.repo();
    const response = await context.octokit.graphql<CommentsQueryResponse>(COMMENTS_QUERY, {
      owner,
      repo,
      number: prNumber,
    });

    const match = findNotice(response.repository.pullRequest.comments.nodes, this.id, isBotNode);

    if (match === undefined) {
      return null;
    }

    return { commentId: Number(match.fullDatabaseId), nodeId: match.id, body: match.body, isMinimized: match.isMinimized };
  }
}
