import type { Context, Probot } from 'probot';
import { escapeMarkdown, pluralize } from '../template.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { Logger } from 'pino';
import { z } from 'zod';

const Settings = z.object({
  name: z.string().optional(),
  treat_merge_commits_as: z.enum(['failure', 'neutral']).optional(),
  exempt_labels: z.array(z.string()).optional(),
  exempt_authors: z.array(z.string()).optional(),
  exempt_branches: z.array(z.object({
    head: z.string().optional(),
    base: z.string().optional(),
  })).optional(),
});

const DEFAULT_NAME = 'Carson / no-merge-commits';
const DEFAULT_TREATMENT: 'failure' | 'neutral' = 'failure';
const MERGE_COMMIT_PARENTS = 2;

type NoMergeCommitsEvent
  = | 'pull_request.opened'
    | 'pull_request.synchronize'
    | 'pull_request.reopened'
    | 'pull_request.labeled'
    | 'pull_request.unlabeled';
type NoMergeCommitsContext = Context<NoMergeCommitsEvent>;

const PR_EVENTS: NoMergeCommitsEvent[] = [
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
  'pull_request.labeled',
  'pull_request.unlabeled',
];

interface MergeCommit {
  sha: string;
  subject: string;
  author: string;
}

const matches = (value: string, pattern: string | undefined, log: Logger): boolean => {
  if (pattern === undefined) {
    return true;
  }

  try {
    return new RegExp(pattern).test(value);
  } catch (error) {
    log.warn(`Skipping exemption pattern "${pattern}": invalid regex (${String(error)})`);

    return false;
  }
};

const exemptionFor = (
  pr: NoMergeCommitsContext['payload']['pull_request'],
  settings: z.infer<typeof Settings>,
  log: Logger,
): string | null => {
  const label = pr.labels.map((l) => l.name).find((name) => settings.exempt_labels?.includes(name) === true);

  if (label !== undefined) {
    return `label \`${label}\``;
  }

  if (pr.user !== null && settings.exempt_authors?.includes(pr.user.login) === true) {
    return `author @${pr.user.login}`;
  }

  const branchRule = (settings.exempt_branches ?? []).find((rule) =>
    (rule.head !== undefined || rule.base !== undefined)
    && matches(pr.head.ref, rule.head, log)
    && matches(pr.base.ref, rule.base, log));

  if (branchRule !== undefined) {
    return `branch rule ${JSON.stringify(branchRule)}`;
  }

  return null;
};

export class NoMergeCommitsSubscriber extends Subscriber {
  public readonly id = 'no-merge-commits';
  public readonly description = 'Posts a check run that fails when a pull request contains merge commits.';
  public readonly requiredPermissions: RequiredPermissions = {
    checks: 'write',
    pull_requests: 'read',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context as NoMergeCommitsContext);
    });
  }

  async #handle(context: NoMergeCommitsContext): Promise<void> {
    const log = this.log();
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const pr = context.payload.pull_request;
    const { owner, repo } = context.repo();
    const check = {
      owner,
      repo,
      name: settings.name ?? DEFAULT_NAME,
      head_sha: pr.head.sha,
      status: 'completed' as const,
    };
    const exemption = exemptionFor(pr, settings, log);

    if (exemption !== null) {
      await context.octokit.rest.checks.create({
        ...check,
        conclusion: 'success',
        output: {
          title: 'Exempt from the merge-commit check',
          summary: `This pull request is exempt by ${exemption}.`,
        },
      });
      log.info(`Check skipped for PR #${pr.number}: exempt by ${exemption}`);

      return;
    }

    const commits = await context.octokit.paginate(context.octokit.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });

    const merges: MergeCommit[] = commits
      .filter((c) => c.parents.length >= MERGE_COMMIT_PARENTS)
      .map((c) => ({
        sha: c.sha,
        subject: c.commit.message.split('\n')[0],
        author: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      }));

    const conclusion = merges.length === 0 ? 'success' : settings.treat_merge_commits_as ?? DEFAULT_TREATMENT;
    const output = merges.length === 0
      ? {
          title: `No merge commits in ${pluralize(commits.length, 'commit')}`,
          summary: 'Every commit in this pull request has a single parent.',
        }
      : {
          title: pluralize(merges.length, 'merge commit'),
          summary: `${merges.length} of ${pluralize(commits.length, 'commit')} ${merges.length === 1 ? 'is a merge commit' : 'are merge commits'}. Rebase the branch onto its base and force-push to clear this check.`,
          text: merges
            .map((c) => `- \`${c.sha.slice(0, 7)}\` ${escapeMarkdown(c.subject)} (${escapeMarkdown(c.author)})`)
            .join('\n'),
        };

    await context.octokit.rest.checks.create({ ...check, conclusion, output });
    log.info(`Check ${conclusion} for PR #${pr.number}`);
  }
}
