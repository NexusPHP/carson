import * as core from '@actions/core';
import app, { carson } from './app.js';
import { dispatchScheduled, type SchedulePayload } from './scheduled.js';
import { createProbot } from 'probot';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { getAppIdentity } from './app-identity.js';
import { readFile } from 'node:fs/promises';
import { runPreflight } from './preflight.js';

const main = async (): Promise<void> => {
  const appId = core.getInput('app_id', { required: true });
  const privateKey = core.getInput('private_key', { required: true });
  const webhookSecret = core.getInput('webhook_secret');

  const eventName = process.env['GITHUB_EVENT_NAME'];
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  const runId = process.env['GITHUB_RUN_ID'];
  const repository = process.env['GITHUB_REPOSITORY'];

  if (eventName === undefined || eventPath === undefined || runId === undefined || repository === undefined) {
    core.setFailed('GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_RUN_ID, and GITHUB_REPOSITORY must be set');
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

  if (!await runPreflight(probot, carson, repository)) {
    return;
  }

  const identity = getAppIdentity();

  if (identity !== null) {
    probot.log.info(`Running as ${identity.slug}[bot] (App "${identity.name}", ID ${identity.id})`);
  }

  if (eventName === 'schedule') {
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
