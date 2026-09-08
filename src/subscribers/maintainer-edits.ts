import type { Context, Probot } from 'probot';
import { interpolate, type TemplateContext } from '../template.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { findCarsonComment } from '../github/comments.js';
import { z } from 'zod';

const Settings = z.object({
  message: z.string().optional(),
});

const COMMENT_MARKER = '<!-- carson:maintainer-edits -->';

const DEFAULT_MESSAGE = `Hey @{{user}}, it looks like "Allow edits from maintainers" is unchecked on this pull request.

That is fine, but maintainers will not be able to rebase, squash, or apply small fixes for you before merging. If you would like them to, please [allow edits from maintainers](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork).`;

type MaintainerEditsEvent = 'pull_request.opened' | 'pull_request.ready_for_review';
type MaintainerEditsContext = Context<MaintainerEditsEvent>;

const PR_EVENTS: MaintainerEditsEvent[] = ['pull_request.opened', 'pull_request.ready_for_review'];

export class MaintainerEditsSubscriber extends Subscriber {
  public readonly id = 'maintainer-edits';
  public readonly description = 'Comments on fork pull requests that do not allow edits from maintainers.';
  public readonly requiredPermissions: RequiredPermissions = {
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context as MaintainerEditsContext);
    });
  }

  async #handle(context: MaintainerEditsContext): Promise<void> {
    const log = this.log(context);
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const pr = context.payload.pull_request;
    const headRepo = pr.head.repo?.full_name;

    if (pr.draft === true || pr.maintainer_can_modify || headRepo === undefined || headRepo === context.payload.repository.full_name) {
      return;
    }

    const { owner, repo } = context.repo();
    const comments = await context.octokit.paginate(context.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const notice = findCarsonComment(comments, {
      marker: COMMENT_MARKER,
      isBotAuthored: (c) => c.user?.type === 'Bot',
    });

    if (notice !== undefined) {
      log.debug(`PR #${pr.number} already carries a maintainer-edits notice, skipping`);

      return;
    }

    const templateContext: TemplateContext = {
      user: pr.user.login,
      repo: context.payload.repository.name,
      number: pr.number,
    };

    await context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: `${interpolate(enabled.settings.message ?? DEFAULT_MESSAGE, templateContext)}\n\n${COMMENT_MARKER}`,
    });
    log.info(`Posted maintainer-edits notice on PR #${pr.number}`);
  }
}
