import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { z } from 'zod';

const QUALIFYING_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;

const Settings = z.object({
  needs_review_label: z.string().optional(),
  needs_rework_label: z.string().optional(),
  approved_label: z.string().optional(),
  qualifying_associations: z.array(z.enum(QUALIFYING_ASSOCIATIONS)).optional(),
});

const DEFAULT_NEEDS_REVIEW = 'needs-review';
const DEFAULT_NEEDS_REWORK = 'needs-rework';
const DEFAULT_APPROVED = 'approved';

type TriagePrEvent
  = | 'pull_request.opened'
    | 'pull_request.reopened'
    | 'pull_request.synchronize'
    | 'pull_request.ready_for_review'
    | 'pull_request.converted_to_draft';

const PR_EVENTS: TriagePrEvent[] = [
  'pull_request.opened',
  'pull_request.reopened',
  'pull_request.synchronize',
  'pull_request.ready_for_review',
  'pull_request.converted_to_draft',
];

type TriageContext = Context<TriagePrEvent | 'pull_request_review.submitted'>;

interface ResolvedSettings {
  needsReviewLabel: string;
  needsReworkLabel: string;
  approvedLabel: string;
  qualifyingAssociations: ReadonlySet<string>;
}

const resolveSettings = (raw: z.infer<typeof Settings>): ResolvedSettings => ({
  needsReviewLabel: raw.needs_review_label ?? DEFAULT_NEEDS_REVIEW,
  needsReworkLabel: raw.needs_rework_label ?? DEFAULT_NEEDS_REWORK,
  approvedLabel: raw.approved_label ?? DEFAULT_APPROVED,
  qualifyingAssociations: new Set<string>(raw.qualifying_associations ?? QUALIFYING_ASSOCIATIONS),
});

type Desired = 'needs_review' | 'needs_rework' | 'approved';

interface ReviewLike {
  state: string;
  user: { login: string } | null;
  author_association: string;
}

const computeDesired = (
  reviews: readonly ReviewLike[],
  qualifying: ReadonlySet<string>,
): Desired => {
  const latest = new Map<string, 'APPROVED' | 'CHANGES_REQUESTED'>();

  for (const review of reviews) {
    if (review.user === null) {
      continue;
    }

    if (!qualifying.has(review.author_association)) {
      continue;
    }

    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED') {
      continue;
    }

    latest.set(review.user.login, review.state);
  }

  const states = Array.from(latest.values());

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
  public readonly description = 'Labels pull requests with their current review state: needs-review, needs-rework, or approved. Reviews from contributors without write access are ignored.';
  public readonly requiredPermissions: RequiredPermissions = {
    issues: 'write',
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context as TriageContext);
    });
    probot.on('pull_request_review.submitted', async (context): Promise<void> => {
      await this.#handle(context as TriageContext);
    });
  }

  async #handle(context: TriageContext): Promise<void> {
    const log = this.log(context);
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const settings = resolveSettings(enabled.settings);
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
      desiredLabel = labelFor(
        computeDesired(reviews as unknown as readonly ReviewLike[], settings.qualifyingAssociations),
        settings,
      );
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
}
