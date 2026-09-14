import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import type { ScheduledContext, ScheduledRegistrar } from '../scheduled.js';
import type { EmitterWebhookEventName } from '@octokit/webhooks';
import { forEachConcurrent } from '../concurrency.js';
import { pluralize } from '../template.js';
import { z } from 'zod';

const Settings = z.object({
  on_close: z.boolean().optional(),
  on_branch_delete: z.boolean().optional(),
  sweep_pull_requests: z.enum(['closed', 'all', 'none']).optional(),
  max_idle_days: z.number().int().positive().optional(),
  max_age_days: z.number().int().positive().optional(),
  protected_refs: z.array(z.string().min(1)).optional(),
});

type Settings = z.infer<typeof Settings>;

const PR_EVENTS = ['pull_request.closed'] satisfies EmitterWebhookEventName[];
const DELETE_EVENTS = ['delete'] satisfies EmitterWebhookEventName[];

type PrContext = Context<(typeof PR_EVENTS)[number]>;
type DeleteContext = Context<(typeof DELETE_EVENTS)[number]>;
type Octokit = ScheduledContext['octokit'];
type Repo = ReturnType<ScheduledContext['repo']>;
type ListedCache = Awaited<ReturnType<Octokit['rest']['actions']['getActionsCacheList']>>['data']['actions_caches'][number];

interface ActionsCache {
  id: number;
  ref: string;
  key: string;
  size_in_bytes: number;
  created_at: string;
  last_accessed_at: string;
}

interface PullCache {
  cache: ActionsCache;
  number: number;
}

interface Pruned {
  count: number;
  bytes: number;
}

const REQUIRED_KEYS = ['id', 'ref', 'key', 'size_in_bytes', 'created_at', 'last_accessed_at'] as const;
const PULL_REF = /^refs\/pull\/(\d+)\/merge$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;

const isComplete = (cache: ListedCache): cache is ActionsCache => REQUIRED_KEYS.every((key) => cache[key] !== undefined);

const prNumber = (ref: string): number | null => {
  const match = PULL_REF.exec(ref);

  return match === null ? null : Number(match[1]);
};

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(2)} MB`;

const olderThan = (timestamp: string, days: number | undefined, now: number): boolean =>
  days !== undefined && new Date(timestamp).getTime() < now - days * MS_PER_DAY;

export class CachePrunerSubscriber extends Subscriber {
  public readonly id = 'cache-pruner';
  public readonly description = 'Deletes GitHub Actions caches left behind by closed pull requests and deleted branches, and sweeps stale caches on schedule.';
  public readonly requiredPermissions: RequiredPermissions = {
    actions: 'write',
    pull_requests: 'read',
  };

  public override register(probot: Probot): void {
    probot.on(PR_EVENTS, async (context): Promise<void> => {
      await this.#handleClosed(context);
    });
    probot.on(DELETE_EVENTS, async (context): Promise<void> => {
      await this.#handleDelete(context);
    });
  }

  public override registerScheduled(registrar: ScheduledRegistrar): void {
    registrar.on(async (context) => {
      await this.#sweep(context);
    });
  }

  async #handleClosed(context: PrContext): Promise<void> {
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null || enabled.settings.on_close === false) {
      return;
    }

    await this.#pruneRef(context.octokit, context.repo(), `refs/pull/${context.payload.pull_request.number}/merge`);
  }

  async #handleDelete(context: DeleteContext): Promise<void> {
    if (context.payload.ref_type !== 'branch') {
      return;
    }

    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null || enabled.settings.on_branch_delete === false) {
      return;
    }

    await this.#pruneRef(context.octokit, context.repo(), `refs/heads/${context.payload.ref}`);
  }

  async #pruneRef(octokit: Octokit, target: Repo, ref: string): Promise<void> {
    const caches = await this.#list(octokit, { ...target, ref });
    const pruned = await this.#delete(octokit, target, caches);

    this.log().info(`Deleted ${pluralize(pruned.count, 'cache')} (${megabytes(pruned.bytes)}) for ${ref}`);
  }

  async #sweep(context: ScheduledContext): Promise<void> {
    const enabled = await this.loadEnabledSettings(context, Settings);

    if (enabled === null) {
      return;
    }

    const { settings } = enabled;
    const log = this.log();
    const mode = settings.sweep_pull_requests ?? 'closed';
    const agesConfigured = settings.max_idle_days !== undefined || settings.max_age_days !== undefined;

    if (mode === 'none' && !agesConfigured) {
      log.debug('Sweep has nothing to do: sweep_pull_requests is none and no age limit is set');

      return;
    }

    const target = context.repo();
    const caches = await this.#list(context.octokit, target);

    log.debug(`Found ${pluralize(caches.length, 'cache')}`);

    const pullCaches: PullCache[] = [];
    const otherCaches: ActionsCache[] = [];

    for (const cache of caches) {
      const number = prNumber(cache.ref);

      if (number === null) {
        otherCaches.push(cache);
      } else {
        pullCaches.push({ cache, number });
      }
    }

    const targets = [
      ...await this.#stalePullCaches(context, pullCaches, mode),
      ...await this.#agedCaches(context, otherCaches, settings),
    ];
    const pruned = await this.#delete(context.octokit, target, targets);

    log.info(`Deleted ${pluralize(pruned.count, 'cache')} (${megabytes(pruned.bytes)}) in sweep`);
  }

  async #stalePullCaches(
    context: ScheduledContext,
    pullCaches: readonly PullCache[],
    mode: 'closed' | 'all' | 'none',
  ): Promise<ActionsCache[]> {
    if (mode === 'none') {
      return [];
    }

    if (mode === 'all') {
      return pullCaches.map((p) => p.cache);
    }

    const { owner, repo } = context.repo();
    const numbers = [...new Set(pullCaches.map((p) => p.number))];
    const closed = new Set<number>();

    await forEachConcurrent(numbers, CONCURRENCY, async (number) => {
      const { data } = await context.octokit.rest.pulls.get({ owner, repo, pull_number: number });

      if (data.state === 'closed') {
        closed.add(number);
      }
    });

    return pullCaches.filter((p) => closed.has(p.number)).map((p) => p.cache);
  }

  async #agedCaches(
    context: ScheduledContext,
    caches: readonly ActionsCache[],
    settings: Settings,
  ): Promise<ActionsCache[]> {
    if (settings.max_idle_days === undefined && settings.max_age_days === undefined) {
      return [];
    }

    const { owner, repo } = context.repo();
    const { data: repository } = await context.octokit.rest.repos.get({ owner, repo });
    const protectedRefs = new Set([`refs/heads/${repository.default_branch}`, ...(settings.protected_refs ?? [])]);
    const now = Date.now();

    return caches.filter((cache) =>
      !protectedRefs.has(cache.ref)
      && (olderThan(cache.last_accessed_at, settings.max_idle_days, now) || olderThan(cache.created_at, settings.max_age_days, now)),
    );
  }

  async #list(octokit: Octokit, params: Repo & { ref?: string }): Promise<ActionsCache[]> {
    const listed = await octokit.paginate(octokit.rest.actions.getActionsCacheList, { ...params, per_page: 100 });

    return listed.filter(isComplete);
  }

  async #delete(octokit: Octokit, { owner, repo }: Repo, caches: readonly ActionsCache[]): Promise<Pruned> {
    const log = this.log();
    const pruned: Pruned = { count: 0, bytes: 0 };

    await forEachConcurrent(caches, CONCURRENCY, async (cache) => {
      try {
        await octokit.rest.actions.deleteActionsCacheById({ owner, repo, cache_id: cache.id });
      } catch (error) {
        log.warn(`Failed to delete cache "${cache.key}" on ${cache.ref}: ${String(error)}`);

        return;
      }

      log.debug(`Deleted cache "${cache.key}" (${megabytes(cache.size_in_bytes)}) on ${cache.ref}`);
      pruned.count += 1;
      pruned.bytes += cache.size_in_bytes;
    });

    return pruned;
  }
}
