import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { forEachConcurrent } from '../concurrency.js';
import { pluralize } from '../template.js';
import { removeLabel } from '../github/labels.js';
import { roleOf } from '../github/roles.js';
import { z } from 'zod';

const QUALIFYING_ROLES = ['admin', 'maintain', 'write'] as const;

const Settings = z.object({
  needs_review_label: z.string().optional(),
  needs_rework_label: z.string().optional(),
  approved_label: z.string().optional(),
  qualifying_roles: z.array(z.enum(QUALIFYING_ROLES)).optional(),
  qualifying_associations: z.unknown().optional(),
  reset_on_push: z.boolean().optional(),
  sweep: z.boolean().optional(),
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

const CONCURRENCY = 5;

type Octokit = ScheduledContext['octokit'];
type Repo = ReturnType<ScheduledContext['repo']>;
type RoleLookup = (username: string) => Promise<string>;

interface Triaged {
  number: number;
  draft: boolean;
  labels: readonly string[];
  headSha: string;
}

const cachedRoles = (octokit: Octokit, { owner, repo }: Repo): RoleLookup => {
  const cache = new Map<string, Promise<string>>();

  return async (username) => {
    const known = cache.get(username) ?? roleOf(octokit, owner, repo, username);

    cache.set(username, known);

    return await known;
  };
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

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    registrar.on(async (context) => {
      await this.#sweep(context);
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

    const pr = context.payload.pull_request;
    const target = context.repo();
    const { desiredLabel } = await this.#reconcile(context.octokit, target, resolveSettings(raw), cachedRoles(context.octokit, target), {
      number: pr.number,
      draft: pr.draft === true,
      labels: pr.labels.map((l) => l.name),
      headSha: pr.head.sha,
    });

    log.info(`Triage label for PR #${pr.number}: ${desiredLabel ?? 'none'}`);
  }

  async #sweep(scheduled: ScheduledContext): Promise<void> {
    const enabled = await this.loadEnabledSettings(scheduled, Settings);

    if (enabled?.settings.sweep !== true) {
      return;
    }

    const log = this.log();
    const settings = resolveSettings(enabled.settings);
    const target = scheduled.repo();
    const roles = cachedRoles(scheduled.octokit, target);
    const prs = await scheduled.octokit.paginate(scheduled.octokit.rest.pulls.list, { ...target, state: 'open', per_page: 100 });
    let changed = 0;

    log.debug(`Found ${pluralize(prs.length, 'open PR')}`);

    await forEachConcurrent(prs, CONCURRENCY, async (pr) => {
      const result = await this.#reconcile(scheduled.octokit, target, settings, roles, {
        number: pr.number,
        draft: pr.draft === true,
        labels: pr.labels.map((l) => l.name),
        headSha: pr.head.sha,
      });

      if (result.changed) {
        changed += 1;
        log.info(`Triage label for PR #${pr.number}: ${result.desiredLabel ?? 'none'}`);
      }
    });

    log.info(`Reconciled ${changed} of ${pluralize(prs.length, 'open PR')}`);
  }

  async #reconcile(
    octokit: Octokit,
    { owner, repo }: Repo,
    settings: ResolvedSettings,
    roles: RoleLookup,
    pr: Triaged,
  ): Promise<{ desiredLabel: string | null; changed: boolean }> {
    const managed = [settings.needsReviewLabel, settings.needsReworkLabel, settings.approvedLabel];
    const currentManaged = pr.labels.filter((n) => managed.includes(n));

    let desiredLabel: string | null = null;

    if (!pr.draft) {
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });
      const desired = await computeDesired(reviews, {
        headSha: pr.headSha,
        resetOnPush: settings.resetOnPush,
        qualifies: async (username) => settings.qualifyingRoles.has(await roles(username)),
      });
      desiredLabel = labelFor(desired, settings);
    }

    const outdated = currentManaged.filter((label) => label !== desiredLabel);
    const missing = desiredLabel !== null && !currentManaged.includes(desiredLabel);

    for (const label of outdated) {
      await removeLabel(octokit, { owner, repo, issue_number: pr.number, name: label });
    }

    if (desiredLabel !== null && missing) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: pr.number,
        labels: [desiredLabel],
      });
    }

    return { desiredLabel, changed: missing || outdated.length > 0 };
  }
}
