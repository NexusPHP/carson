import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { z } from 'zod';

const QUALIFYING_ROLES = ['admin', 'maintain', 'write'] as const;

const Settings = z.object({
  needs_review_label: z.string().optional(),
  needs_rework_label: z.string().optional(),
  approved_label: z.string().optional(),
  qualifying_roles: z.array(z.enum(QUALIFYING_ROLES)).optional(),
  qualifying_associations: z.unknown().optional(),
  reset_on_push: z.boolean().optional(),
});

const DEFAULT_NEEDS_REVIEW = 'needs-review';
const DEFAULT_NEEDS_REWORK = 'needs-rework';
const DEFAULT_APPROVED = 'approved';

const PR_EVENTS = [
  'pull_request.opened',
  'pull_request.reopened',
  'pull_request.synchronize',
  'pull_request.ready_for_review',
  'pull_request.converted_to_draft',
] satisfies EmitterWebhookEventName[];
const REVIEW_EVENTS = ['pull_request_review.submitted', 'pull_request_review.dismissed'] satisfies EmitterWebhookEventName[];

type TriageContext = Context<(typeof PR_EVENTS)[number] | (typeof REVIEW_EVENTS)[number]>;

interface ResolvedSettings {
  needsReviewLabel: string;
  needsReworkLabel: string;
  approvedLabel: string;
  qualifyingRoles: ReadonlySet<string>;
  resetOnPush: boolean;
}

const resolveSettings = (raw: z.infer<typeof Settings>): ResolvedSettings => ({
  needsReviewLabel: raw.needs_review_label ?? DEFAULT_NEEDS_REVIEW,
  needsReworkLabel: raw.needs_rework_label ?? DEFAULT_NEEDS_REWORK,
  approvedLabel: raw.approved_label ?? DEFAULT_APPROVED,
  qualifyingRoles: new Set<string>(raw.qualifying_roles ?? QUALIFYING_ROLES),
  resetOnPush: raw.reset_on_push ?? false,
});

type Desired = 'needs_review' | 'needs_rework' | 'approved';
type Verdict = 'APPROVED' | 'CHANGES_REQUESTED';

interface ReviewLike {
  state: string;
  user: { login: string } | null;
  commit_id: string | null;
}

interface LatestReview {
  verdict: Verdict;
  commitId: string | null;
}

const latestReviews = (reviews: readonly ReviewLike[]): Map<string, LatestReview> => {
  const latest = new Map<string, LatestReview>();

  for (const review of reviews) {
    if (review.user === null) {
      continue;
    }

    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED') {
      continue;
    }

    latest.set(review.user.login, { verdict: review.state, commitId: review.commit_id });
  }

  return latest;
};

interface Evaluation {
  headSha: string;
  resetOnPush: boolean;
  qualifies: (login: string) => Promise<boolean>;
}

const computeDesired = async (reviews: readonly ReviewLike[], evaluation: Evaluation): Promise<Desired> => {
  const states: Verdict[] = [];

  for (const [login, { verdict, commitId }] of latestReviews(reviews)) {
    if (evaluation.resetOnPush && verdict === 'CHANGES_REQUESTED' && commitId !== evaluation.headSha) {
      continue;
    }

    if (await evaluation.qualifies(login)) {
      states.push(verdict);
    }
  }

  if (states.includes('CHANGES_REQUESTED')) {
    return 'needs_rework';
  }

  if (states.includes('APPROVED')) {
    return 'approved';
  }

  return 'needs_review';
};

const labelFor = (desired: Desired, settings: ResolvedSettings): string => {
  if (desired === 'needs_rework') {
    return settings.needsReworkLabel;
  }

  if (desired === 'approved') {
    return settings.approvedLabel;
  }

  return settings.needsReviewLabel;
};

export class TriageLabelerSubscriber extends Subscriber {
  public readonly id = 'triage-labeler';
  public readonly description = 'Labels pull requests with their current review state: needs-review, needs-rework, or approved. Reviews from users without write access are ignored.';
  public readonly requiredPermissions: RequiredPermissions = {
    issues: 'write',
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context);
    });
    probot.on(REVIEW_EVENTS, async (context): Promise<void> => {
      await this.#handle(context);
    });
  }

  async #handle(context: TriageContext): Promise<void> {
    const log = this.log();
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const raw = enabled.settings;

    if (raw.qualifying_associations !== undefined) {
      log.warn('qualifying_associations is no longer supported, use qualifying_roles instead');
    }

    const settings = resolveSettings(raw);
    const pr = context.payload.pull_request;
    const { owner, repo } = context.repo();
    const managed = [settings.needsReviewLabel, settings.needsReworkLabel, settings.approvedLabel];
    const currentManaged = pr.labels.map((l) => l.name).filter((n) => managed.includes(n));

    let desiredLabel: string | null = null;

    if (pr.draft !== true) {
      const reviews = await context.octokit.paginate(context.octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });
      const qualifies = async (username: string): Promise<boolean> =>
        settings.qualifyingRoles.has(await this.#roleOf(context, owner, repo, username));
      const desired = await computeDesired(reviews as unknown as readonly ReviewLike[], {
        headSha: pr.head.sha,
        resetOnPush: settings.resetOnPush,
        qualifies,
      });
      desiredLabel = labelFor(desired, settings);
    }

    for (const label of currentManaged) {
      if (label !== desiredLabel) {
        await context.octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number: pr.number,
          name: label,
        });
      }
    }

    if (desiredLabel !== null && !currentManaged.includes(desiredLabel)) {
      await context.octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: pr.number,
        labels: [desiredLabel],
      });
    }

    log.info(`Triage label for PR #${pr.number}: ${desiredLabel ?? 'none'}`);
  }

  // author_association hides private org members from an App, so the gate is the reviewer's actual repository role.
  async #roleOf(context: TriageContext, owner: string, repo: string, username: string): Promise<string> {
    try {
      const { data } = await context.octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });

      return data.role_name;
    } catch {
      return 'none';
    }
  }
}
