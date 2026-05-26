import type { Context, Probot } from 'probot';
import type { CarsonConfig } from '../configuration/schema.js';
import { interpolate } from '../template.js';
import { Subscriber } from '../subscriber.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const Settings = z.object({
  message: z.string().optional(),
});

const DEFAULT_MESSAGE = '@{{user}} this PR has merge conflicts with `{{base}}`. Please rebase or resolve them.';
const COMMENT_MARKER = '<!-- carson:conflicts-notifier -->';

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

const COMMENTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100) {
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

const MINIMIZE_MUTATION = `mutation($subjectId: ID!) {
  minimizeComment(input: { subjectId: $subjectId, classifier: RESOLVED }) {
    minimizedComment { isMinimized }
  }
}`;

const UNMINIMIZE_MUTATION = `mutation($subjectId: ID!) {
  unminimizeComment(input: { subjectId: $subjectId }) {
    unminimizedComment { ... on IssueComment { id } }
  }
}`;

export class ConflictsNotifierSubscriber extends Subscriber {
  public readonly id = 'conflicts-notifier';
  public readonly description = 'Comments on PRs with merge conflicts and marks the comment resolved when fixed.';

  public register(probot: Probot): void {
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

    await this.#checkPR(context, context.payload.pull_request.number, config);
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

    for (const pr of prs) {
      await this.#checkPR(context, pr.number, config);
    }
  }

  async #checkPR(context: SubscriberContext, prNumber: number, config: CarsonConfig): Promise<void> {
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
      const settings = subscriberSettings(config, this.id, Settings) ?? {};
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
      await context.octokit.graphql(UNMINIMIZE_MUTATION, { subjectId: existing.id });
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

    await context.octokit.graphql(MINIMIZE_MUTATION, { subjectId: existing.id });
    context.log.info(`resolved conflict notice on PR #${prNumber}`);
  }

  async #findExistingComment(context: SubscriberContext, prNumber: number): Promise<ExistingComment | null> {
    const { owner, repo } = context.repo();
    const response = await context.octokit.graphql<CommentsQueryResponse>(COMMENTS_QUERY, {
      owner,
      repo,
      number: prNumber,
    });

    // Filter to bot-authored comments so a human PR participant can't forge
    // the marker in their own comment and steal/suppress the lookup.
    const match = response.repository.pullRequest.comments.nodes.find((node) =>
      node.author?.__typename === 'Bot' && node.body.includes(COMMENT_MARKER),
    );

    if (match === undefined) {
      return null;
    }

    return { id: match.id, isMinimized: match.isMinimized };
  }
}
