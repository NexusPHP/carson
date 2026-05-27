import { type ApplicationFunction, run } from 'probot';
import { carson } from './app.js';
import { logger } from './logger.js';
import { runPreflight } from './preflight.js';

const devApp: ApplicationFunction = async (probot) => {
  carson.run(probot);
  const log = logger.for('dev');
  const repository = process.env['DEV_REPOSITORY'];

  if (repository !== undefined && repository.length > 0) {
    const preflightError = await runPreflight(probot, carson, repository);

    if (preflightError !== null) {
      log.error(preflightError);
      process.exit(1);
    }
  } else {
    log.warn('Preflight skipped (set DEV_REPOSITORY=owner/repo to enable)');
  }

  // pull_request_target carries the same payload shape as pull_request.
  // Mirror it so subscribers register pull_request.* once and fire for both.
  probot.onAny(async ({ id, name, payload }) => {
    if ((name as string) === 'pull_request_target') {
      await probot.receive({ id, name: 'pull_request', payload } as never);
    }
  });
};

await run(devApp);
