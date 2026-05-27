import type { Context, Probot } from 'probot';
import { findCarsonComment, minimizeComment, unminimizeComment } from '../github/comments.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { CarsonConfig } from '../configuration/schema.js';
import { forEachConcurrent } from '../concurrency.js';
import { interpolate } from '../template.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const Settings = z.object({
  message: z.string().optional(),
});

const DEFAULT_MESSAGE = '@{{user}} this PR has merge conflicts with `{{base}}`. Please rebase or resolve them.';
const COMMENT_MARKER = '<!-- carson:conflicts-notifier -->';
const CONCURRENCY = 5;

type PrEvent = 'pull_request.opened' | 'pull_request.synchronize' | 'pull_request.reopened';
type SupportedEvent = PrEvent | 'push';
type SubscriberContext = Context<SupportedEvent>;

const PR_EVENTS: PrEvent[] = [
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
];

interface ExistingComment {
  id: string;
  isMinimized: boolean;
}

interface CommentsQueryResponse {
  repository: {
    pullRequest: {
      comments: {
        nodes: {
          id: string;
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
    if (context.isBot) {
      return;
    }

    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    await this.#checkPr(context, context.payload.pull_request.number, config);
  }

  async #handlePushEvent(context: Context<'push'>): Promise<void> {
    if (context.isBot) {
      return;
    }

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
      context.log.info(`mergeable not yet computed for PR #${prNumber}, skipping`);
      return;
    }

    if (pr.user === null) {
      return;
    }

    const hasConflict = pr.mergeable === false;
    const existing = await this.#findExistingComment(context, prNumber);

    if (hasConflict) {
      await this.#handleConflict(context, pr, config, existing);
    } else {
      await this.#handleNoConflict(context, prNumber, existing);
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
    config: CarsonConfig,
    existing: ExistingComment | null,
  ): Promise<void> {
    const { owner, repo } = context.repo();

    if (existing === null) {
      const settings = subscriberSettings(config, this.id, Settings, context.log) ?? {};
      const message = interpolate(settings.message ?? DEFAULT_MESSAGE, {
        user: pr.user.login,
        repo,
        number: pr.number,
        title: pr.title,
        base: pr.base.ref,
      });
      const body = `${message}\n\n${COMMENT_MARKER}`;

      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pr.number,
        body,
      });
      context.log.info(`posted conflict notice on PR #${pr.number}`);
      return;
    }

    if (existing.isMinimized) {
      await unminimizeComment(context.octokit, existing.id);
      context.log.info(`reopened conflict notice on PR #${pr.number}`);
    }
  }

  async #handleNoConflict(
    context: SubscriberContext,
    prNumber: number,
    existing: ExistingComment | null,
  ): Promise<void> {
    if (existing === null || existing.isMinimized) {
      return;
    }

    await minimizeComment(context.octokit, existing.id, 'RESOLVED');
    context.log.info(`resolved conflict notice on PR #${prNumber}`);
  }

  async #findExistingComment(context: SubscriberContext, prNumber: number): Promise<ExistingComment | null> {
    const { owner, repo } = context.repo();
    const response = await context.octokit.graphql<CommentsQueryResponse>(COMMENTS_QUERY, {
      owner,
      repo,
      number: prNumber,
    });

    const match = findCarsonComment(response.repository.pullRequest.comments.nodes, {
      marker: COMMENT_MARKER,
      isBotAuthored: (node) => node.author?.__typename === 'Bot',
    });

    if (match === undefined) {
      return null;
    }

    return { id: match.id, isMinimized: match.isMinimized };
  }
}
