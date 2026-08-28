import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import app from '../../src/app.js';
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { resetConfigCache } from '../../src/configuration/cache.js';
import { signBody } from '../../src/webhook.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const INSTALLATION_ID = 12345;
const MARKER = '<!-- carson:issue-intake:support-ticket:tkt_8f3a2c -->';
const HOOK_URL = 'https://app.example.com/api/support/github-webhook';
const SECRET = 'test-webhook-secret';

const mockInstallationToken = (): void => {
  nock('https://api.github.com')
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' });
};

interface SettingsOverrides {
  url?: string;
  secret_env?: string;
  events?: string[];
  require_marker?: boolean;
  labels?: string[];
}

// JSON is valid YAML, so configs are served as JSON strings.
const configFor = (settings: SettingsOverrides = {}, subscribers: string[] = ['webhook-notifier']): string =>
  JSON.stringify({
    version: 1,
    subscribers,
    settings: {
      'webhook-notifier': {
        url: HOOK_URL,
        secret_env: 'CARSON_WEBHOOK_SECRET',
        events: ['issues.closed', 'issues.reopened'],
        labels: ['support'],
        ...settings,
      },
    },
  });

const mockConfig = (yaml: string | null): void => {
  const scope = nock('https://api.github.com');

  if (yaml === null) {
    scope
      .get('/repos/acme/support/contents/.github%2Fcarson.yml').reply(404)
      .get('/repos/acme/.github/contents/.github%2Fcarson.yml').reply(404);

    return;
  }

  scope
    .get('/repos/acme/support/contents/.github%2Fcarson.yml')
    .reply(200, yaml);
};

interface IssueOverrides {
  body?: string | null;
  user?: { login: string; type?: string } | null;
  labels?: ({ name: string } | null)[] | undefined;
  state?: string | undefined;
  state_reason?: string | null;
  senderType?: string;
}

const issuesPayload = (action: 'closed' | 'reopened', overrides: IssueOverrides = {}): Record<string, unknown> => {
  const issue: Record<string, unknown> = {
    number: 42,
    title: '[bug] Export fails on large TB',
    html_url: 'https://github.com/acme/support/issues/42',
    body: overrides.body === undefined ? `Steps…\n\n${MARKER}` : overrides.body,
    user: overrides.user === undefined ? { login: 'carson-acme[bot]', type: 'Bot' } : overrides.user,
    state_reason: overrides.state_reason === undefined ? 'completed' : overrides.state_reason,
  };

  if (!('state' in overrides)) {
    issue['state'] = action === 'closed' ? 'closed' : 'open';
  } else if (overrides.state !== undefined) {
    issue['state'] = overrides.state;
  }

  if (!('labels' in overrides)) {
    issue['labels'] = [{ name: 'support' }];
  } else if (overrides.labels !== undefined) {
    issue['labels'] = overrides.labels;
  }

  return {
    action,
    installation: { id: INSTALLATION_ID },
    issue,
    repository: {
      owner: { login: 'acme' },
      name: 'support',
    },
    sender: { type: overrides.senderType ?? 'User' },
  };
};

const receiveIssues = async (
  probot: Probot,
  action: 'closed' | 'reopened' = 'closed',
  overrides: IssueOverrides = {},
): Promise<void> => {
  await probot.receive({
    id: 'evt-notifier',
    name: 'issues',
    payload: issuesPayload(action, overrides) as never,
  });
};

describe('webhook-notifier subscriber (via app)', () => {
  let probot: Probot;

  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    resetConfigCache();
    vi.stubEnv('CARSON_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('GITHUB_RUN_ID', 'run-777');
    probot = new Probot({
      appId: 123,
      privateKey,
      logLevel: 'fatal',
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    await probot.load(app);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    nock.cleanAll();
  });

  it('delivers a signed payload with marker-derived ref on issues.closed', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    let capturedBody: Record<string, unknown> = {};
    let signature = '';
    const hookScope = nock('https://app.example.com')
      .post('/api/support/github-webhook')
      .matchHeader('content-type', 'application/json')
      .matchHeader('x-carson-event', 'issues.closed')
      .matchHeader('x-carson-delivery', 'run-777')
      .reply(function (_uri, body) {
        capturedBody = body as Record<string, unknown>;
        signature = this.req.headers['x-carson-signature-256'] as unknown as string;
        return [200];
      });

    await receiveIssues(probot);

    expect(hookScope.isDone()).toBe(true);
    expect(capturedBody).toMatchObject({
      version: 1,
      event: 'issues.closed',
      ref: 'tkt_8f3a2c',
      dispatch_event_type: 'support-ticket',
      issue: {
        number: 42,
        title: '[bug] Export fails on large TB',
        state: 'closed',
        state_reason: 'completed',
        html_url: 'https://github.com/acme/support/issues/42',
      },
      repository: 'acme/support',
    });
    expect(capturedBody['delivered_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(signature).toBe(signBody(SECRET, JSON.stringify(capturedBody)));
  });

  it('delivers issues.reopened when configured', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const hookScope = nock('https://app.example.com')
      .post('/api/support/github-webhook', (body: { event: string; issue: { state: string } }) => {
        expect(body.event).toBe('issues.reopened');
        expect(body.issue.state).toBe('open');
        return true;
      })
      .reply(200);

    await receiveIssues(probot, 'reopened');

    expect(hookScope.isDone()).toBe(true);
  });

  it('delivers when the closer is a bot (automation closing tracked issues still notifies)', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const hookScope = nock('https://app.example.com')
      .post('/api/support/github-webhook')
      .reply(200);

    await receiveIssues(probot, 'closed', { senderType: 'Bot' });

    expect(hookScope.isDone()).toBe(true);
  });

  it('sends null state and state_reason and an empty delivery id when the payload and env omit them', async () => {
    vi.stubEnv('GITHUB_RUN_ID', undefined as never);
    mockInstallationToken();
    mockConfig(configFor());

    const hookScope = nock('https://app.example.com')
      .post('/api/support/github-webhook', (body: { issue: { state: null; state_reason: null } }) => {
        expect(body.issue.state).toBeNull();
        expect(body.issue.state_reason).toBeNull();
        return true;
      })
      .matchHeader('x-carson-delivery', '')
      .reply(200);

    await receiveIssues(probot, 'closed', { state: undefined, state_reason: null });

    expect(hookScope.isDone()).toBe(true);
  });

  it('skips when the action is not in the configured events', async () => {
    mockInstallationToken();
    mockConfig(configFor({ events: ['issues.closed'] }));

    await receiveIssues(probot, 'reopened');
  });

  it('skips when the issue carries none of the configured labels', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await receiveIssues(probot, 'closed', { labels: [{ name: 'unrelated' }, null] });
  });

  it('skips when the issue has no labels at all', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await receiveIssues(probot, 'closed', { labels: undefined });
  });

  it('delivers without a label filter when labels is empty', async () => {
    mockInstallationToken();
    mockConfig(configFor({ labels: [] }));

    const hookScope = nock('https://app.example.com')
      .post('/api/support/github-webhook')
      .reply(200);

    await receiveIssues(probot, 'closed', { labels: undefined });

    expect(hookScope.isDone()).toBe(true);
  });

  it('skips when require_marker is on and the body has no marker', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await receiveIssues(probot, 'closed', { body: 'no marker here' });
  });

  it('skips when require_marker is on and the issue author is not a Bot (forgery defense)', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await receiveIssues(probot, 'closed', { user: { login: 'mallory', type: 'User' } });
  });

  it('skips when require_marker is on and the issue has no author (ghost)', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await receiveIssues(probot, 'closed', { user: null });
  });

  it('delivers with null ref and dispatch_event_type when require_marker is off', async () => {
    mockInstallationToken();
    mockConfig(configFor({ require_marker: false }));

    const hookScope = nock('https://app.example.com')
      .post('/api/support/github-webhook', (body: { ref: null; dispatch_event_type: null }) => {
        expect(body.ref).toBeNull();
        expect(body.dispatch_event_type).toBeNull();
        return true;
      })
      .reply(200);

    await receiveIssues(probot, 'closed', { body: 'no marker', user: { login: 'someone', type: 'User' } });

    expect(hookScope.isDone()).toBe(true);
  });

  it('throws when the secret_env variable is not set', async () => {
    vi.stubEnv('CARSON_WEBHOOK_SECRET', undefined as never);
    mockInstallationToken();
    mockConfig(configFor());

    await expect(receiveIssues(probot))
      .rejects.toThrow('Environment variable "CARSON_WEBHOOK_SECRET" named by secret_env is not set');
  });

  it('throws when the secret_env variable is empty', async () => {
    vi.stubEnv('CARSON_WEBHOOK_SECRET', '');
    mockInstallationToken();
    mockConfig(configFor());

    await expect(receiveIssues(probot))
      .rejects.toThrow('Environment variable "CARSON_WEBHOOK_SECRET" named by secret_env is not set');
  });

  it('throws when the receiver rejects the delivery', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    nock('https://app.example.com')
      .post('/api/support/github-webhook')
      .reply(410);

    await expect(receiveIssues(probot))
      .rejects.toThrow(`Webhook delivery to ${HOOK_URL} failed with status 410`);
  });

  it('does nothing when settings are invalid (non-https url)', async () => {
    mockInstallationToken();
    mockConfig(configFor({ url: 'http://app.example.com/hook' }));

    await receiveIssues(probot);
  });

  it('does nothing when settings are invalid (unparseable url)', async () => {
    mockInstallationToken();
    mockConfig(configFor({ url: 'not a url' }));

    await receiveIssues(probot);
  });

  it('does nothing when settings are absent', async () => {
    mockInstallationToken();
    mockConfig(JSON.stringify({ version: 1, subscribers: ['webhook-notifier'] }));

    await receiveIssues(probot);
  });

  it('does nothing when webhook-notifier is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig(configFor({}, ['welcome']));

    await receiveIssues(probot);
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await receiveIssues(probot);
  });
});
