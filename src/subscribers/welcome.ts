import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { interpolate } from '../template.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const FIRST_TIME_ASSOCIATIONS = ['FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR'] as const;
const RETURNING_ASSOCIATIONS = ['CONTRIBUTOR', 'MEMBER', 'COLLABORATOR', 'OWNER'] as const;

const FirstTimeBucket = z.object({
  pull_request: z.string().optional(),
  issue: z.string().optional(),
  author_association: z.array(z.enum(FIRST_TIME_ASSOCIATIONS)).optional(),
});

const ReturningBucket = z.object({
  pull_request: z.string().optional(),
  issue: z.string().optional(),
  author_association: z.array(z.enum(RETURNING_ASSOCIATIONS)).optional(),
});

const Settings = z.object({
  first_time: FirstTimeBucket.optional(),
  returning: ReturningBucket.optional(),
});

type BucketKey = 'first_time' | 'returning';
type ParsedSettings = z.infer<typeof Settings>;

const DEFAULT_MESSAGES: Readonly<Record<BucketKey, { pull_request: string; issue: string }>> = {
  first_time: {
    pull_request: 'Thanks for opening your first pull request, @{{user}}!',
    issue: 'Thanks for opening your first issue, @{{user}}!',
  },
  returning: {
    pull_request: 'Thanks for the pull request, @{{user}}!',
    issue: 'Thanks for filing this, @{{user}}!',
  },
};

const DEFAULT_ASSOCIATIONS: Readonly<Record<BucketKey, readonly string[]>> = {
  first_time: FIRST_TIME_ASSOCIATIONS,
  returning: RETURNING_ASSOCIATIONS,
};

const associationsFor = (settings: ParsedSettings, bucket: BucketKey): readonly string[] => {
  return settings[bucket]?.author_association ?? DEFAULT_ASSOCIATIONS[bucket];
};

const bucketFor = (settings: ParsedSettings, association: string): BucketKey | null => {
  if (associationsFor(settings, 'first_time').includes(association)) {
    return 'first_time';
  }

  if (associationsFor(settings, 'returning').includes(association)) {
    return 'returning';
  }

  return null;
};

const messageFor = (settings: ParsedSettings, bucket: BucketKey, event: 'pull_request' | 'issue'): string => {
  return settings[bucket]?.[event] ?? DEFAULT_MESSAGES[bucket][event];
};

export class WelcomeSubscriber extends Subscriber {
  public readonly id = 'welcome';
  public readonly description = 'Greets contributors on pull requests and issues. First-time and returning contributors are configured independently.';
  public readonly requiredPermissions: RequiredPermissions = { issues: 'write' };

  public override register(probot: Probot): void {
    probot.on('pull_request.opened', async (context: Context<'pull_request.opened'>): Promise<void> => {
      if (context.isBot) {
        return;
      }

      const config = await this.loadEnabledConfig(context);

      if (config === null) {
        return;
      }

      const settings = subscriberSettings(config, this.id, Settings, context.log) ?? {};
      const bucket = bucketFor(settings, context.payload.pull_request.author_association);

      if (bucket === null) {
        return;
      }

      const body = interpolate(messageFor(settings, bucket, 'pull_request'), {
        user: context.payload.pull_request.user.login,
        repo: context.payload.repository.name,
        number: context.payload.pull_request.number,
        title: context.payload.pull_request.title,
      });

      await context.octokit.rest.issues.createComment(context.issue({ body }));

      context.log.info(`commented on pull_request #${context.payload.pull_request.number}`);
    });

    probot.on('issues.opened', async (context: Context<'issues.opened'>): Promise<void> => {
      if (context.isBot) {
        return;
      }

      const issue = context.payload.issue;

      if (issue.user === null) {
        return;
      }

      const config = await this.loadEnabledConfig(context);

      if (config === null) {
        return;
      }

      const settings = subscriberSettings(config, this.id, Settings, context.log) ?? {};
      const bucket = bucketFor(settings, issue.author_association);

      if (bucket === null) {
        return;
      }

      const body = interpolate(messageFor(settings, bucket, 'issue'), {
        user: issue.user.login,
        repo: context.payload.repository.name,
        number: issue.number,
        title: issue.title,
      });

      await context.octokit.rest.issues.createComment(context.issue({ body }));

      context.log.info(`commented on issue #${context.payload.issue.number}`);
    });
  }
}
