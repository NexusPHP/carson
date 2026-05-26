import type { Context, Probot } from 'probot';
import { interpolate } from '../template.js';
import { Subscriber } from '../subscriber.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const Settings = z.object({
  pull_request: z.string().optional(),
  issue: z.string().optional(),
});

const DEFAULT_PR_MESSAGE = 'Thanks for opening your first pull request, @{{user}}!';
const DEFAULT_ISSUE_MESSAGE = 'Thanks for opening your first issue, @{{user}}!';
const FIRST_TIMER_ASSOCIATIONS: readonly string[] = ['FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR'];

const isFirstTimer = (association: string): boolean => FIRST_TIMER_ASSOCIATIONS.includes(association);

export class WelcomeSubscriber extends Subscriber {
  public readonly id = 'welcome';
  public readonly description = 'Greets first-time contributors on their first pull request or issue.';

  public register(probot: Probot): void {
    probot.on('pull_request.opened', async (context: Context<'pull_request.opened'>): Promise<void> => {
      if (context.isBot) {
        return;
      }

      if (!isFirstTimer(context.payload.pull_request.author_association)) {
        return;
      }

      const config = await this.loadEnabledConfig(context);

      if (config === null) {
        return;
      }

      const settings = subscriberSettings(config, this.id, Settings) ?? {};
      const body = interpolate(settings.pull_request ?? DEFAULT_PR_MESSAGE, {
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

      if (!isFirstTimer(issue.author_association)) {
        return;
      }

      const config = await this.loadEnabledConfig(context);

      if (config === null) {
        return;
      }

      const settings = subscriberSettings(config, this.id, Settings) ?? {};
      const body = interpolate(settings.issue ?? DEFAULT_ISSUE_MESSAGE, {
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
