import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1_000;

// Mirrors GitHub's own webhook signing so receivers can reuse existing
// verification code.
export const signBody = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export interface DeliverOptions {
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
}

export const deliver = async (
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  options: DeliverOptions = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  for (let attempt = 1; ; attempt++) {
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        body,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(`Webhook delivery to ${url} failed: ${String(error)}`, { cause: error });
      }

      await sleep(backoffMs * attempt);
      continue;
    }

    if (response.ok) {
      return;
    }

    const failure = new Error(`Webhook delivery to ${url} failed with status ${response.status}`);

    // 4xx is a receiver rejection that a retry cannot fix.
    if (response.status < 500 || attempt >= attempts) {
      throw failure;
    }

    await sleep(backoffMs * attempt);
  }
};
