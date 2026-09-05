import type { Context, Probot } from 'probot';
import { escapeMarkdown, pluralize } from '../template.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { z } from 'zod';

const Settings = z.object({
  name: z.string().optional(),
  treat_unsigned_as: z.enum(['failure', 'neutral']).optional(),
});

const DEFAULT_NAME = 'Carson / signed-commits';
const DEFAULT_TREATMENT: 'failure' | 'neutral' = 'failure';

type SignedCommitsEvent = 'pull_request.opened' | 'pull_request.synchronize' | 'pull_request.reopened';
type SignedCommitsContext = Context<SignedCommitsEvent>;

const PR_EVENTS: SignedCommitsEvent[] = [
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
];

interface UnsignedCommit {
  sha: string;
  subject: string;
  author: string;
}

export class SignedCommitsSubscriber extends Subscriber {
  public readonly id = 'signed-commits';
  public readonly description = 'Posts a check run requiring all commits in a pull request to be signed and verified.';
  public readonly requiredPermissions: RequiredPermissions = {
    checks: 'write',
    pull_requests: 'read',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context as SignedCommitsContext);
    });
  }

  async #handle(context: SignedCommitsContext): Promise<void> {
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const checkName = settings.name ?? DEFAULT_NAME;
    const treatment = settings.treat_unsigned_as ?? DEFAULT_TREATMENT;

    const pr = context.payload.pull_request;
    const { owner, repo } = context.repo();

    const commits = await context.octokit.paginate(context.octokit.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });

    const unsigned: UnsignedCommit[] = commits
      .filter((c) => c.commit.verification?.verified !== true)
      .map((c) => ({
        sha: c.sha,
        subject: c.commit.message.split('\n')[0],
        author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      }));

    const conclusion = unsigned.length === 0 ? 'success' : treatment;
    const output = unsigned.length === 0
      ? {
          title: `All ${pluralize(commits.length, 'commit')} signed`,
          summary: `Every commit in this pull request has a verified signature.`,
        }
      : {
          title: pluralize(unsigned.length, 'unsigned commit'),
          summary: `${unsigned.length} of ${pluralize(commits.length, 'commit')} ${unsigned.length === 1 ? 'is' : 'are'} unsigned. Sign your commits with GPG or SSH and force-push to clear this check.`,
          text: unsigned
            .map((c) => `- \`${c.sha.slice(0, 7)}\` ${escapeMarkdown(c.subject)} (${escapeMarkdown(c.author)})`)
            .join('\n'),
        };

    await context.octokit.rest.checks.create({
      owner,
      repo,
      name: checkName,
      head_sha: pr.head.sha,
      status: 'completed',
      conclusion,
      output,
    });

    this.log(context).info(`Check ${conclusion} for PR #${pr.number}`);
  }
}
