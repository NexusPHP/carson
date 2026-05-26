import * as core from '@actions/core';
import app, { carson } from './app.js';
import { dispatchScheduled, type SchedulePayload } from './scheduled.js';
import { createProbot } from 'probot';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { readFile } from 'node:fs/promises';

const main = async (): Promise<void> => {
  const appId = core.getInput('app_id', { required: true });
  const privateKey = core.getInput('private_key', { required: true });
  const webhookSecret = core.getInput('webhook_secret');

  const eventName = process.env['GITHUB_EVENT_NAME'];
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  const runId = process.env['GITHUB_RUN_ID'];

  if (eventName === undefined || eventPath === undefined || runId === undefined) {
    core.setFailed('GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, and GITHUB_RUN_ID must be set');
    return;
  }

  const payload: unknown = JSON.parse(await readFile(eventPath, 'utf8'));
  const probot = createProbot({
    overrides: {
      appId,
      privateKey,
      ...(webhookSecret.length > 0 ? { secret: webhookSecret } : {}),
    },
  });
  let handlerFailed = false;

  probot.onError((error) => {
    probot.log.error(error);
    handlerFailed = true;
  });

  await probot.load(app);

  if (eventName === 'schedule') {
    const repository = process.env['GITHUB_REPOSITORY'];

    if (repository === undefined) {
      core.setFailed('GITHUB_REPOSITORY must be set for scheduled events');
      return;
    }

    const result = await dispatchScheduled(probot, carson.scheduled, repository, payload as SchedulePayload);

    if (result.failed) {
      handlerFailed = true;
    }
  } else {
    // pull_request_target has the same payload as pull_request. Route both
    // to the same handlers so subscribers register one event name.
    const name = eventName === 'pull_request_target' ? 'pull_request' : eventName;
    await probot.receive({
      id: runId,
      name,
      payload,
    } as EmitterWebhookEvent);
  }

  if (handlerFailed) {
    core.setFailed('One or more subscribers failed');
  }
};

await main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
