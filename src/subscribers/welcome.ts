import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { roleOf, ROLES } from '../github/roles.js';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { interpolate } from '../template.js';
import { searchTimestamp } from '../github/search.js';
import { z } from 'zod';

const Message = z.union([z.string(), z.literal(false)]).optional();

const Bucket = z.object({
  pull_request: Message,
  issue: Message,
  author_association: z.unknown().optional(),
});

const Settings = z.object({
  first_time: z.union([Bucket, z.literal(false)]).optional(),
  returning: z.union([Bucket, z.literal(false)]).optional(),
  exempt_roles: z.array(z.enum(ROLES)).optional(),
});

const PR_EVENTS = ['pull_request.opened'] satisfies EmitterWebhookEventName[];
const ISSUE_EVENTS = ['issues.opened'] satisfies EmitterWebhookEventName[];
const BUCKETS = ['first_time', 'returning'] as const;

type WelcomeContext = Context<(typeof PR_EVENTS)[number] | (typeof ISSUE_EVENTS)[number]>;
type BucketKey = (typeof BUCKETS)[number];
type ItemKind = 'pull_request' | 'issue';
type ParsedSettings = z.infer<typeof Settings>;

interface Opened {
  kind: ItemKind;
  number: number;
  login: string;
  title: string;
  createdAt: string;
}

const DEFAULT_MESSAGES: Readonly<Record<BucketKey, Record<ItemKind, string>>> = {
  first_time: {
    pull_request: 'Thanks for opening your first pull request, @{{user}}!',
    issue: 'Thanks for opening your first issue, @{{user}}!',
  },
  returning: {
    pull_request: 'Thanks for the pull request, @{{user}}!',
    issue: 'Thanks for filing this, @{{user}}!',
  },
};

const usesAssociations = (settings: ParsedSettings): boolean =>
  BUCKETS.some((key) => {
    const bucket = settings[key];

    return bucket !== undefined && bucket !== false && bucket.author_association !== undefined;
  });

const messageFor = (settings: ParsedSettings, key: BucketKey, kind: ItemKind): string | null => {
  const bucket = settings[key];

  if (bucket === false) {
    return null;
  }

  if (Array.isArray(bucket?.author_association) && bucket.author_association.length === 0) {
    return null;
  }

  const message = bucket?.[kind] ?? DEFAULT_MESSAGES[key][kind];

  return message === false || message === '' ? null : message;
};

export class WelcomeSubscriber extends Subscriber {
  public readonly id = 'welcome';
  public readonly description = 'Greets contributors on pull requests and issues. First-time and returning contributors are configured independently.';
  public readonly requiredPermissions: RequiredPermissions = { issues: 'write', pull_requests: 'write' };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      if (context.isBot) {
        return;
      }

      const pr = context.payload.pull_request;

      await this.#greet(context, {
        kind: 'pull_request',
        number: pr.number,
        login: pr.user.login,
        title: pr.title,
        createdAt: pr.created_at,
      });
    });

    probot.on(ISSUE_EVENTS, async (context): Promise<void> => {
      if (context.isBot) {
        return;
      }

      const issue = context.payload.issue;

      if (issue.user === null) {
        this.log().debug(`Issue #${issue.number}: no user (ghost), skipping`);

        return;
      }

      await this.#greet(context, {
        kind: 'issue',
        number: issue.number,
        login: issue.user.login,
        title: issue.title,
        createdAt: issue.created_at,
      });
    });
  }

  async #greet(context: WelcomeContext, opened: Opened): Promise<void> {
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const log = this.log();
    const item = `${opened.kind === 'issue' ? 'Issue' : 'PR'} #${opened.number}`;

    if (usesAssociations(settings)) {
      log.warn('author_association is no longer supported: first-time status is looked up instead, and exempt_roles skips maintainers. An empty list still switches its bucket off.');
    }

    const messages = {
      first_time: messageFor(settings, 'first_time', opened.kind),
      returning: messageFor(settings, 'returning', opened.kind),
    };

    if (messages.first_time === null && messages.returning === null) {
      log.debug(`${item}: greetings are switched off, skipping`);

      return;
    }

    const { owner, repo } = context.repo();
    const exemptRoles: readonly string[] = settings.exempt_roles ?? [];

    if (exemptRoles.length > 0) {
      const role = await roleOf(context.octokit, owner, repo, opened.login);

      if (exemptRoles.includes(role)) {
        log.debug(`${item}: "${opened.login}" has "${role}" role, exempt from greetings`);

        return;
      }
    }

    let message = messages.first_time;

    if (messages.first_time !== messages.returning) {
      const bucket = await this.#bucketOf(context, opened);

      if (bucket === null) {
        return;
      }

      log.debug(`${item}: "${opened.login}" resolved to bucket "${bucket}"`);
      message = messages[bucket];
    }

    if (message === null) {
      log.debug(`${item}: greeting for this bucket is switched off, skipping`);

      return;
    }

    const body = interpolate(message, {
      user: opened.login,
      repo: context.payload.repository.name,
      number: opened.number,
      title: opened.title,
    });

    this.notice(context, opened.number, body);

    log.info(`Commented on ${opened.kind === 'issue' ? 'issue' : 'PR'} #${opened.number}`);
  }

  // The new item is excluded by date because the search index may or may not hold it yet.
  async #bucketOf(context: WelcomeContext, opened: Opened): Promise<BucketKey | null> {
    const { owner, repo } = context.repo();
    const type = opened.kind === 'issue' ? 'is:issue' : 'is:pr';
    const before = searchTimestamp(new Date(opened.createdAt).getTime());

    try {
      const { data } = await context.octokit.rest.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} ${type} author:${opened.login} created:<${before}`,
        advanced_search: 'true',
        per_page: 1,
      });

      return data.total_count === 0 ? 'first_time' : 'returning';
    } catch (error) {
      this.log().warn(`Could not look up earlier items by "${opened.login}", skipping the greeting: ${String(error)}`);

      return null;
    }
  }
}
