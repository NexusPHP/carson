import type { Context, Probot } from 'probot';
import { findNotice, fromRestComment, isBotComment } from '../github/notices.js';
import { interpolate, type TemplateContext } from '../template.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { z } from 'zod';

const Settings = z.object({
  branches: z.array(z.string()).optional(),
  message: z.string().optional(),
});

const DEFAULT_MESSAGE = `Hey @{{user}}, thanks for the pull request!

It targets \`{{base}}\`, which is no longer maintained. Could you [change the base branch](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-base-branch-of-a-pull-request) to one of these instead? {{branches}}`;

type UnsupportedBranchEvent = 'pull_request.opened' | 'pull_request.ready_for_review' | 'pull_request.edited';
type UnsupportedBranchContext = Context<UnsupportedBranchEvent>;

const PR_EVENTS: UnsupportedBranchEvent[] = [
  'pull_request.opened',
  'pull_request.ready_for_review',
  'pull_request.edited',
];

export class UnsupportedBranchSubscriber extends Subscriber {
  public readonly id = 'unsupported-branch';
  public readonly description = 'Comments on pull requests that target a branch outside the maintained set.';
  public readonly requiredPermissions: RequiredPermissions = {
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context as UnsupportedBranchContext);
    });
  }

  async #handle(context: UnsupportedBranchContext): Promise<void> {
    const log = this.log();
    const pr = context.payload.pull_request;

    if (context.payload.action === 'edited' && context.payload.changes.base === undefined) {
      return;
    }

    if (pr.draft === true) {
      return;
    }

    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const branches = settings.branches ?? [];

    if (branches.length === 0) {
      log.debug('No branches configured, skipping');

      return;
    }

    const { owner, repo } = context.repo();
    const supported = pr.base.ref === context.payload.repository.default_branch || branches.includes(pr.base.ref);
    const comments = await context.octokit.paginate(context.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const notice = findNotice(comments, this.id, isBotComment);

    if (supported) {
      if (notice !== undefined) {
        await this.resolveNotice(context, pr.number, fromRestComment(notice), 'OUTDATED');
        log.info(`Minimized unsupported-branch notice on PR #${pr.number}`);
      }

      return;
    }

    if (notice !== undefined) {
      log.debug(`PR #${pr.number} already carries an unsupported-branch notice, skipping`);

      return;
    }

    const templateContext: TemplateContext = {
      user: pr.user.login,
      repo: context.payload.repository.name,
      number: pr.number,
      base: pr.base.ref,
      branches: branches.map((b) => `\`${b}\``).join(', '),
    };

    this.notice(context, pr.number, interpolate(settings.message ?? DEFAULT_MESSAGE, templateContext));
    log.info(`Posted unsupported-branch notice on PR #${pr.number} (base "${pr.base.ref}")`);
  }
}
