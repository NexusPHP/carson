import type { Context, Probot } from 'probot';
import { deliver, signBody } from '../webhook.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { parseIssueIntakeMarker } from '../github/markers.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const EVENT_VALUES = ['issues.closed', 'issues.reopened'] as const;

const isSafeHttpsUrl = (value: string): boolean => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return url.protocol === 'https:' && url.username === '' && url.password === '';
};

const Settings = z.object({
  url: z.string().refine(isSafeHttpsUrl, { message: 'url must be https:// without userinfo' }),
  secret_env: z.string().min(1),
  events: z.array(z.enum(EVENT_VALUES)).default(['issues.closed']),
  require_marker: z.boolean().default(true),
  labels: z.array(z.string().min(1)).default([]),
});

type NotifierEvent = (typeof EVENT_VALUES)[number];
type NotifierContext = Context<NotifierEvent>;

export class WebhookNotifierSubscriber extends Subscriber {
  public readonly id = 'webhook-notifier';
  public readonly description = 'POSTs a signed JSON payload to a consumer-configured URL when tracked issues change state.';
  public readonly requiredPermissions: RequiredPermissions = {};

  public override register(probot: Probot): void {
    probot.on([...EVENT_VALUES], async (context: NotifierContext): Promise<void> => {
      await this.#handle(context);
    });
  }

  async #handle(context: NotifierContext): Promise<void> {
    const log = this.log(context);
    // No bot-sender bail on purpose: a tracked issue closed by automation
    // (another bot, or Carson's own scheduled subscribers) must still notify.
    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    const settings = subscriberSettings(config, this.id, Settings, log);

    if (settings === undefined) {
      log.debug('No valid webhook-notifier settings, skipping');
      return;
    }

    const event: NotifierEvent = `issues.${context.payload.action}`;
    const issue = context.payload.issue;

    if (!settings.events.includes(event)) {
      log.debug(`Event ${event} not in configured events, skipping`);
      return;
    }

    if (settings.labels.length > 0) {
      const issueLabels = (issue.labels ?? []).map((label) => label?.name);

      if (!settings.labels.some((label) => issueLabels.includes(label))) {
        log.debug(`Issue #${issue.number} carries none of the configured labels, skipping`);
        return;
      }
    }

    let ref: string | null = null;
    let dispatchEventType: string | null = null;

    if (settings.require_marker) {
      const marker = parseIssueIntakeMarker(issue.body);

      if (marker === null || issue.user?.type !== 'Bot') {
        log.debug(`Issue #${issue.number} has no bot-authored issue-intake marker, skipping`);
        return;
      }

      ref = marker.ref;
      dispatchEventType = marker.eventType;
    }

    const secret = process.env[settings.secret_env];

    if (secret === undefined || secret.length === 0) {
      throw new Error(`Environment variable "${settings.secret_env}" named by secret_env is not set`);
    }

    const { owner, repo } = context.repo();
    const body = JSON.stringify({
      version: 1,
      event,
      ref,
      dispatch_event_type: dispatchEventType,
      issue: {
        number: issue.number,
        title: issue.title,
        state: issue.state ?? null,
        state_reason: issue.state_reason ?? null,
        html_url: issue.html_url,
      },
      repository: `${owner}/${repo}`,
      delivered_at: new Date().toISOString(),
    });

    await deliver(settings.url, body, {
      'content-type': 'application/json',
      'x-carson-event': event,
      'x-carson-delivery': process.env['GITHUB_RUN_ID'] ?? '',
      'x-carson-signature-256': signBody(secret, body),
    });

    log.info(`Delivered ${event} for issue #${issue.number}`);
  }
}
