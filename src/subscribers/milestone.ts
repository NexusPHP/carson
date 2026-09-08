import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { Logger } from 'pino';
import { z } from 'zod';

const Rule = z.object({
  labels: z.array(z.string()).optional(),
  base: z.string().optional(),
  milestone: z.string(),
});

const Settings = z.object({
  rules: z.array(Rule).optional(),
  override: z.boolean().optional(),
});

type Rule = z.infer<typeof Rule>;

const NEXT_OPEN = 'next-open';

type MilestoneEvent
  = | 'pull_request.opened'
    | 'pull_request.ready_for_review'
    | 'pull_request.labeled'
    | 'pull_request.edited';
type MilestoneContext = Context<MilestoneEvent>;

const PR_EVENTS: MilestoneEvent[] = [
  'pull_request.opened',
  'pull_request.ready_for_review',
  'pull_request.labeled',
  'pull_request.edited',
];

interface OpenMilestone {
  number: number;
  title: string;
  due_on: string | null;
}

interface Target {
  base: string;
  labels: readonly string[];
}

const UNDATED = '\uffff';

const byDueThenTitle = (a: OpenMilestone, b: OpenMilestone): number => {
  const [dueA, dueB] = [a.due_on ?? UNDATED, b.due_on ?? UNDATED];

  if (dueA !== dueB) {
    return dueA < dueB ? -1 : 1;
  }

  return a.title.localeCompare(b.title, undefined, { numeric: true });
};

const matchBase = (rule: Rule, base: string, log: Logger): RegExpExecArray | null | undefined => {
  if (rule.base === undefined) {
    return undefined;
  }

  try {
    return new RegExp(rule.base).exec(base);
  } catch (error) {
    log.warn(`Skipping milestone rule "${rule.milestone}": invalid regex (${String(error)})`);

    return null;
  }
};

const resolveTitle = (rules: readonly Rule[], target: Target, log: Logger): string | null => {
  for (const rule of rules) {
    if (rule.labels !== undefined && !rule.labels.some((label) => target.labels.includes(label))) {
      continue;
    }

    const match = matchBase(rule, target.base, log);

    if (match === null) {
      continue;
    }

    return match === undefined
      ? rule.milestone
      : rule.milestone.replace(/\$(\d+)/g, (_, index: string) => match[Number(index)] ?? '');
  }

  return null;
};

const pick = (title: string | null, open: readonly OpenMilestone[]): OpenMilestone | null => {
  if (title === null) {
    return null;
  }

  if (title === NEXT_OPEN) {
    return [...open].sort(byDueThenTitle)[0] ?? null;
  }

  return open.find((m) => m.title === title) ?? null;
};

export class MilestoneSubscriber extends Subscriber {
  public readonly id = 'milestone';
  public readonly description = 'Assigns a milestone to pull requests from rules on the base branch and labels.';
  public readonly requiredPermissions: RequiredPermissions = {
    issues: 'write',
    pull_requests: 'write',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handle(context as MilestoneContext);
    });
  }

  async #handle(context: MilestoneContext): Promise<void> {
    const log = this.log(context);
    const pr = context.payload.pull_request;
    const previousBase = context.payload.action === 'edited' ? context.payload.changes.base?.ref.from : undefined;

    if (context.payload.action === 'edited' && previousBase === undefined) {
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
    const rules = settings.rules ?? [];

    if (rules.length === 0) {
      log.debug('No rules configured, skipping');

      return;
    }

    const labels = pr.labels.map((l) => l.name);
    const { owner, repo } = context.repo();
    const open = await context.octokit.paginate(context.octokit.rest.issues.listMilestones, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    }) as OpenMilestone[];
    const wanted = pick(resolveTitle(rules, { base: pr.base.ref, labels }, log), open);
    const current = pr.milestone;

    if (wanted === null || wanted.number === current?.number) {
      return;
    }

    if (current !== null && settings.override !== true) {
      const previous = previousBase === undefined
        ? null
        : pick(resolveTitle(rules, { base: previousBase, labels }, log), open);

      if (previous?.number !== current.number) {
        log.info(`PR #${pr.number} already has milestone "${current.title}", leaving it`);

        return;
      }
    }

    await context.octokit.rest.issues.update({
      owner,
      repo,
      issue_number: pr.number,
      milestone: wanted.number,
    });
    log.info(`Milestone "${wanted.title}" set on PR #${pr.number}`);
  }
}
