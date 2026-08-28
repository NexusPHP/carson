import { buildIssueIntakeMarker, REF_REGEX } from '../github/markers.js';
import type { Context, Probot } from 'probot';
import { escapeMarkdown, interpolate, type TemplateContext } from '../template.js';
import { type RequiredPermissions, Subscriber } from '../subscriber.js';
import { subscriberSettings } from '../configuration/schema.js';
import { z } from 'zod';

const TITLE_LIMIT = 256;
const BODY_LIMIT = 65536;

const FieldSpec = z.object({
  required: z.boolean().default(false),
  escape: z.boolean().default(false),
});

const EventSettings = z.object({
  ref_field: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  labels: z.array(z.string().min(1)).default([]),
  label_field: z.string().min(1).optional(),
  label_allowlist: z.array(z.string().min(1)).optional(),
  fields: z.record(z.string().min(1), FieldSpec).default({}),
  dedupe: z.boolean().default(false),
}).refine((event) => event.label_field === undefined || event.label_allowlist !== undefined, {
  message: 'label_allowlist is required when label_field is set',
});

const Settings = z.object({
  events: z.record(z.string().regex(/^[\w.-]{1,100}$/), EventSettings)
    .refine((events) => Object.keys(events).length > 0, { message: 'events must not be empty' }),
});

type EventConfig = z.infer<typeof EventSettings>;
type IntakeContext = Context<'repository_dispatch'>;

// A malformed payload is a sender bug: throw so the run fails visibly
// instead of dropping the ticket silently.
const buildTemplateContext = (
  eventType: string,
  eventConfig: EventConfig,
  payload: Readonly<Record<string, unknown>>,
): { templateContext: TemplateContext; ref: string } => {
  const templateContext: Record<string, string | number> = {};

  for (const [name, spec] of Object.entries(eventConfig.fields)) {
    const value = payload[name];

    if (value === undefined || value === null) {
      if (spec.required) {
        throw new Error(`Missing required field "${name}" in client_payload for "${eventType}"`);
      }

      continue;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`Field "${name}" in client_payload for "${eventType}" must be a string or number, got ${typeof value}`);
    }

    templateContext[name] = spec.escape && typeof value === 'string' ? escapeMarkdown(value) : value;
  }

  const refValue = payload[eventConfig.ref_field];

  if (typeof refValue !== 'string' && typeof refValue !== 'number') {
    throw new Error(`ref_field "${eventConfig.ref_field}" is missing from client_payload for "${eventType}" or is not a string or number`);
  }

  const ref = String(refValue);

  if (!REF_REGEX.test(ref)) {
    throw new Error(`ref_field "${eventConfig.ref_field}" value "${ref}" must match ${REF_REGEX.source}`);
  }

  templateContext[eventConfig.ref_field] = ref;

  return { templateContext, ref };
};

export class IssueIntakeSubscriber extends Subscriber {
  public readonly id = 'issue-intake';
  public readonly description = 'Turns repository_dispatch events into labeled issues carrying a correlation marker.';
  public readonly requiredPermissions: RequiredPermissions = { issues: 'write' };

  public override register(probot: Probot): void {
    probot.on('repository_dispatch', async (context: IntakeContext): Promise<void> => {
      await this.#handle(context);
    });
  }

  async #handle(context: IntakeContext): Promise<void> {
    const log = this.log(context);
    // Dispatch senders are machines (an App-minted token has a Bot sender),
    // so this skips loadEnabledSettings' bot-sender guard on purpose.
    const config = await this.loadEnabledConfig(context);

    if (config === null) {
      return;
    }

    const settings = subscriberSettings(config, this.id, Settings, log);

    if (settings === undefined) {
      log.debug('No valid issue-intake settings, skipping');
      return;
    }

    const eventType = context.payload.action;
    const eventConfig = settings.events[eventType];

    if (eventConfig === undefined) {
      log.debug(`No event configured for "${eventType}", skipping`);
      return;
    }

    const payload = context.payload.client_payload;

    if (payload === null) {
      throw new Error(`client_payload is missing for "${eventType}"`);
    }

    const { templateContext, ref } = buildTemplateContext(eventType, eventConfig, payload);
    const marker = buildIssueIntakeMarker(eventType, ref);
    const { owner, repo } = context.repo();

    if (eventConfig.dedupe) {
      const { data: existing } = await context.octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'all',
        ...(eventConfig.labels.length > 0 ? { labels: eventConfig.labels.join(',') } : {}),
        sort: 'created',
        direction: 'desc',
        per_page: 100,
      });
      const duplicate = existing.find((issue) => issue.body?.endsWith(marker) === true);

      if (duplicate !== undefined) {
        log.info(`Issue #${duplicate.number} already exists for ${eventType} ref ${ref}, skipping`);
        return;
      }
    }

    const labels = [...eventConfig.labels];

    if (eventConfig.label_field !== undefined) {
      const labelValue = payload[eventConfig.label_field];

      if (typeof labelValue === 'string' && eventConfig.label_allowlist?.includes(labelValue) === true) {
        labels.push(labelValue);
      } else {
        log.warn(`Value of label_field "${eventConfig.label_field}" is not in label_allowlist, label skipped`);
      }
    }

    const title = interpolate(eventConfig.title, templateContext).slice(0, TITLE_LIMIT);
    const bodyBudget = BODY_LIMIT - marker.length - 2;
    const body = `${interpolate(eventConfig.body, templateContext).slice(0, bodyBudget)}\n\n${marker}`;

    const { data: issue } = await context.octokit.rest.issues.create({
      owner,
      repo,
      title,
      body,
      ...(labels.length > 0 ? { labels } : {}),
    });

    log.info(`Created issue #${issue.number} for ${eventType} ref ${ref}`);
  }
}
