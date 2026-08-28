import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import type { ApplicationFunction } from 'probot';
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

// Mirrors a GITHUB_EVENT_PATH payload for a repository_dispatch-triggered
// workflow run, after the entrypoint's installation enrichment: `action` is
// the sender-chosen event_type and `client_payload` is the sender's data.
const dispatchPayload = (eventType: string): Record<string, unknown> => ({
  action: eventType,
  branch: 'main',
  client_payload: {
    ticket_id: 'tkt_8f3a2c',
    kind: 'bug',
    subject: 'Export fails on large TB',
    description: 'Steps to reproduce…',
    attempts: 3,
  },
  installation: { id: 12345 },
  repository: {
    owner: { login: 'acme' },
    name: 'support',
  },
  sender: { type: 'User', login: 'octocat' },
});

const makeProbot = async (app: ApplicationFunction): Promise<Probot> => {
  const probot = new Probot({
    appId: 123,
    privateKey,
    logLevel: 'fatal',
    Octokit: ProbotOctokit.defaults({
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
  });
  await probot.load(app);

  return probot;
};

describe('repository_dispatch routing', () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  it('delivers a custom event_type to a plain repository_dispatch handler with client_payload intact', async () => {
    const seen: Record<string, unknown>[] = [];
    const probot = await makeProbot((p) => {
      p.on('repository_dispatch', (context) => {
        seen.push(context.payload as unknown as Record<string, unknown>);
      });
    });

    await probot.receive({
      id: 'evt-dispatch-1',
      name: 'repository_dispatch',
      payload: dispatchPayload('support-ticket') as never,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.['action']).toBe('support-ticket');
    expect(seen[0]?.['client_payload']).toEqual({
      ticket_id: 'tkt_8f3a2c',
      kind: 'bug',
      subject: 'Export fails on large TB',
      description: 'Steps to reproduce…',
      attempts: 3,
    });
  });

  it('delivers every event_type to the same handler, so subscribers branch on payload.action', async () => {
    const actions: string[] = [];
    const probot = await makeProbot((p) => {
      p.on('repository_dispatch', (context) => {
        actions.push(context.payload.action);
      });
    });

    await probot.receive({
      id: 'evt-dispatch-2',
      name: 'repository_dispatch',
      payload: dispatchPayload('support-ticket') as never,
    });
    await probot.receive({
      id: 'evt-dispatch-3',
      name: 'repository_dispatch',
      payload: dispatchPayload('unrelated-type') as never,
    });

    expect(actions).toEqual(['support-ticket', 'unrelated-type']);
  });
});
