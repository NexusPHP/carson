import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deliver, signBody } from '../src/webhook.js';
import nock from 'nock';

const URL = 'https://app.example.com/api/hook';
const FAST = { backoffMs: 0 };

describe('signBody', () => {
  it('produces a GitHub-style sha256 HMAC signature', () => {
    expect(signBody('shhh', '{"a":1}'))
      .toBe('sha256=82a2822723ef5d74e78b2082b74ec3369cc9cf94e58ed4dc61f5c1e2887fd7c7');
  });
});

describe('deliver', () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('POSTs the body with the given headers and resolves on 2xx with default options', async () => {
    const scope = nock('https://app.example.com')
      .post('/api/hook', '{"a":1}')
      .matchHeader('x-carson-event', 'issues.closed')
      .reply(200);

    await deliver(URL, '{"a":1}', { 'x-carson-event': 'issues.closed' });

    expect(scope.isDone()).toBe(true);
  });

  it('retries after a 5xx and resolves when a later attempt succeeds', async () => {
    const scope = nock('https://app.example.com')
      .post('/api/hook').reply(502)
      .post('/api/hook').reply(200);

    await deliver(URL, '{}', {}, FAST);

    expect(scope.isDone()).toBe(true);
  });

  it('retries after a network error and resolves when a later attempt succeeds', async () => {
    const scope = nock('https://app.example.com')
      .post('/api/hook').replyWithError('ECONNRESET')
      .post('/api/hook').reply(204);

    await deliver(URL, '{}', {}, FAST);

    expect(scope.isDone()).toBe(true);
  });

  it('throws after exhausting all attempts on 5xx', async () => {
    const scope = nock('https://app.example.com')
      .post('/api/hook').times(3).reply(500);

    await expect(deliver(URL, '{}', {}, FAST))
      .rejects.toThrow(`Webhook delivery to ${URL} failed with status 500`);
    expect(scope.isDone()).toBe(true);
  });

  it('throws after exhausting all attempts on network errors', async () => {
    const scope = nock('https://app.example.com')
      .post('/api/hook').times(2).replyWithError('ECONNREFUSED');

    await expect(deliver(URL, '{}', {}, { ...FAST, attempts: 2 }))
      .rejects.toThrow(`Webhook delivery to ${URL} failed: Error: ECONNREFUSED`);
    expect(scope.isDone()).toBe(true);
  });

  it('throws immediately on a 4xx without retrying', async () => {
    const scope = nock('https://app.example.com')
      .post('/api/hook').reply(403);

    await expect(deliver(URL, '{}', {}, FAST))
      .rejects.toThrow(`Webhook delivery to ${URL} failed with status 403`);
    expect(scope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });
});
