import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { interpolate } from '../template.js';
import { z } from 'zod';

const Settings = z.object({
  message: z.string().optional(),
});

const DEFAULT_MESSAGE = 'Thanks for the contribution, @{{user}}!';

export class ThanksSubscriber extends Subscriber {
  public readonly id = 'thanks';
  public readonly description = 'Posts a thank-you comment when a pull request is merged by someone other than its author. Skips bot and ghost authors.';
  public readonly requiredPermissions: RequiredPermissions = { pull_requests: 'write' };

  public override register(probot: Probot): void {
    probot.on('pull_request.closed', async (context: Context<'pull_request.closed'>): Promise<void> => {
      const log = this.log(context);
      const pr = context.payload.pull_request;

      if (!pr.merged) {
        return;
      }

      if (pr.user === null) {
        log.debug(`PR #${pr.number}: no user (ghost), skipping`);

        return;
      }

      if (pr.user.type === 'Bot') {
        log.debug(`PR #${pr.number}: author is a bot (${pr.user.login}), skipping`);

        return;
      }

      if (pr.user.login === pr.merged_by?.login) {
        log.debug(`PR #${pr.number}: self-merge by ${pr.user.login}, skipping`);

        return;
      }

      const enabled = await this.loadEnabledSettings(context, Settings);

      if (enabled === null) {
        return;
      }

      const body = interpolate(enabled.settings.message ?? DEFAULT_MESSAGE, {
        user: pr.user.login,
        repo: context.payload.repository.name,
        number: pr.number,
        title: pr.title,
      });

      await context.octokit.rest.issues.createComment(context.issue({ body }));

      log.info(`Commented on PR #${pr.number}`);
    });
  }
}
