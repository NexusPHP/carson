import type { Context, Probot } from 'probot';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { interpolate } from '../template.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const DEFAULT_MESSAGE = 'This repository is read-only, so this {{type}} has been closed.';

const Settings = z.object({
  upstream: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'upstream must be owner/repo').optional(),
  message: z.string().min(1).default(DEFAULT_MESSAGE),
  lock: z.boolean().default(true),
  issues: z.boolean().default(true),
  pull_requests: z.boolean().default(true),
});

type ReadOnlyEvent = 'issues.opened' | 'pull_request.opened';
type ReadOnlyContext = Context<ReadOnlyEvent>;

export class ReadOnlySubscriber extends Subscriber {
  public readonly id = 'read-only';
  public readonly description = 'Closes issues and pull requests opened on a read-only repository, pointing to the upstream.';
  public readonly requiredPermissions: RequiredPermissions = { issues: 'write', pull_requests: 'write' };

  public override register(probot: Probot): void {
    probot.on(['issues.opened', 'pull_request.opened'], async (context: ReadOnlyContext): Promise<void> => {
      await this.#handle(context);
    });
  }

  async #handle(context: ReadOnlyContext): Promise<void> {
    const log = this.log(context);
    // No bot-sender bail on purpose: automated PRs against a mirror are
    // exactly what should be closed.
    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    const settings = subscriberSettings(config, this.id, Settings, log) ?? Settings.parse({});
    const payload = context.payload;
    const isIssue = 'issue' in payload;
    const item = 'issue' in payload ? payload.issue : payload.pull_request;

    if (isIssue ? !settings.issues : !settings.pull_requests) {
      log.debug(`#${item.number}: ${isIssue ? 'Issues' : 'Pull requests'} not guarded, skipping`);
      return;
    }

    const { owner, repo } = context.repo();
    const templateContext: Record<string, string | number> = {
      number: item.number,
      repo,
      type: isIssue ? 'issue' : 'pull request',
    };

    if (item.user !== null) {
      templateContext['user'] = item.user.login;
    }

    if (settings.upstream !== undefined) {
      const url = `https://github.com/${settings.upstream}`;
      templateContext['upstream'] = `[${settings.upstream}](${url})`;
      templateContext['upstream_url'] = url;
    }

    await context.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: item.number,
      body: interpolate(settings.message, templateContext),
    });

    await context.octokit.rest.issues.update({
      owner,
      repo,
      issue_number: item.number,
      state: 'closed',
      ...(isIssue ? { state_reason: 'not_planned' as const } : {}),
    });

    log.info(`Closed ${templateContext['type']} #${item.number}`);

    if (settings.lock) {
      await this.dispatch('lock', context, { number: item.number });
    }
  }
}
