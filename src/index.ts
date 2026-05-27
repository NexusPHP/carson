import * as core from '@actions/core';
import app, { carson } from './app.js';
import { dispatchScheduled, type SchedulePayload } from './scheduled.js';
import { INVALID_REPOSITORY_MESSAGE, parseRepository } from './github/repository.js';
import { appIdentity } from './app-identity.js';
import { createProbot } from 'probot';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { logger } from './logger.js';
import { readFile } from 'node:fs/promises';
import { runPreflight } from './preflight.js';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const isLogLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as readonly string[]).includes(value);

const main = async (): Promise<void> => {
  const appId = core.getInput('app_id', { required: true });
  const privateKey = core.getInput('private_key', { required: true });
  const webhookSecret = core.getInput('webhook_secret');
  const logLevelInput = core.getInput('log_level');
  let logLevel: LogLevel | undefined;

  if (logLevelInput.length > 0) {
    if (!isLogLevel(logLevelInput)) {
      core.setFailed(`log_level must be one of: ${LOG_LEVELS.join(', ')}. Got: "${logLevelInput}"`);
      return;
    }

    logLevel = logLevelInput;
  }

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
      ...(logLevel !== undefined ? { logLevel } : {}),
    },
  });
  let handlerFailed = false;

  probot.onError((error) => {
    logger.for('carson').error(error);
    handlerFailed = true;
  });

  await probot.load(app);
  const log = logger.for('carson');
  const preflightError = await runPreflight(probot, carson, repository);

  if (preflightError !== null) {
    core.setFailed(preflightError);
    return;
  }

  if (appIdentity.current !== null) {
    log.info(`Running as ${appIdentity.login} ("${appIdentity.name}")`);
  }

  if (eventName === 'schedule') {
    log.info('Received schedule');
    const result = await dispatchScheduled(probot, carson.scheduled, repository, payload as SchedulePayload);

    if (result.failed) {
      handlerFailed = true;
    }
  } else {
    // pull_request_target has the same payload as pull_request. Route both
    // to the same handlers so subscribers register one event name.
    const name = eventName === 'pull_request_target' ? 'pull_request' : eventName;
    // GITHUB_EVENT_PATH payloads omit the installation key that Probot needs
    // to mint a per-installation token, so resolve it from the repository.
    const parsed = parseRepository(repository);

    if (parsed === null) {
      core.setFailed(INVALID_REPOSITORY_MESSAGE);
      return;
    }

    const { owner, repo } = parsed;
    const appOctokit = await probot.auth();
    const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
    const action = (payload as { action?: unknown }).action;
    const eventLabel = typeof action === 'string' ? `${name}.${action}` : name;
    log.info(`Received ${eventLabel}`);
    log.debug(`Resolved installation ${installation.id}`);
    const enrichedPayload = {
      ...(payload as Record<string, unknown>),
      installation: { id: installation.id },
    };
    await probot.receive({
      id: runId,
      name,
      payload: enrichedPayload,
    } as EmitterWebhookEvent);
  }

  if (handlerFailed) {
    core.setFailed('One or more subscribers failed');
  }
};

await main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
