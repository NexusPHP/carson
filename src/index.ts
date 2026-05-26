import * as core from '@actions/core';
import app from './app.js';
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
  await probot.receive({
    id: runId,
    name: eventName,
    payload,
  } as EmitterWebhookEvent);

  if (handlerFailed) {
    core.setFailed('One or more subscribers failed');
  }
};

await main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
