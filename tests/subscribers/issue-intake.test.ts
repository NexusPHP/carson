import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import app from '../../src/app.js';
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { resetConfigCache } from '../../src/configuration/cache.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const INSTALLATION_ID = 12345;
const MARKER = '<!-- carson:issue-intake:support-ticket:tkt_8f3a2c -->';

const mockInstallationToken = (): void => {
  nock('https://api.github.com')
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' });
};

interface EventOverrides {
  ref_field?: string;
  title?: string;
  body?: string;
  labels?: string[];
  // undefined is allowed so a test can strip the base config's key
  // (JSON.stringify drops undefined-valued properties).
  label_field?: string | undefined;
  label_allowlist?: string[] | undefined;
  fields?: Record<string, { required?: boolean; escape?: boolean }>;
  dedupe?: boolean;
}

// JSON is valid YAML, so configs are served as JSON strings.
const configFor = (event: EventOverrides = {}, subscribers: string[] = ['issue-intake']): string =>
  JSON.stringify({
    version: 1,
    subscribers,
    settings: {
      'issue-intake': {
        events: {
          'support-ticket': {
            ref_field: 'ticket_id',
            title: '[{{kind}}] {{subject}}',
            body: '{{description}}\n\nTicket `{{ticket_id}}`.',
            labels: ['support'],
            label_field: 'kind',
            label_allowlist: ['bug', 'feature-request'],
            fields: {
              kind: { required: true },
              subject: { required: true, escape: true },
              description: { required: true },
            },
            ...event,
          },
        },
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

const defaultTicket = {
  ticket_id: 'tkt_8f3a2c',
  kind: 'bug',
  subject: 'Export fails on large TB',
  description: 'Steps to reproduce…',
};

const dispatchPayload = (
  clientPayload: unknown = defaultTicket,
  overrides: { eventType?: string; senderType?: string } = {},
): Record<string, unknown> => ({
  action: overrides.eventType ?? 'support-ticket',
  branch: 'main',
  client_payload: clientPayload,
  installation: { id: INSTALLATION_ID },
  repository: {
    owner: { login: 'acme' },
    name: 'support',
  },
  sender: { type: overrides.senderType ?? 'User', login: 'sender' },
});

const receiveDispatch = async (
  probot: Probot,
  clientPayload: unknown = defaultTicket,
  overrides: { eventType?: string; senderType?: string } = {},
): Promise<void> => {
  await probot.receive({
    id: 'evt-intake',
    name: 'repository_dispatch',
    payload: dispatchPayload(clientPayload, overrides) as never,
  });
};

describe('issue-intake subscriber (via app)', () => {
  let probot: Probot;

  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    resetConfigCache();
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
    nock.cleanAll();
  });

  it('creates a labeled issue with interpolated title and body and the marker as the final line', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues', (body: { title: string; body: string; labels: string[] }) => {
        expect(body.title).toBe('[bug] Export fails on large TB');
        expect(body.body).toBe(`Steps to reproduce…\n\nTicket \`tkt_8f3a2c\`.\n\n${MARKER}`);
        expect(body.labels).toEqual(['support', 'bug']);
        return true;
      })
      .reply(201, { number: 42 });

    await receiveDispatch(probot);

    expect(createScope.isDone()).toBe(true);
  });

  it('creates the issue for a Bot sender (dispatches sent with an App token)', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues')
      .reply(201, { number: 42 });

    await receiveDispatch(probot, defaultTicket, { senderType: 'Bot' });

    expect(createScope.isDone()).toBe(true);
  });

  it('escapes markdown specials in fields marked escape: true and leaves other fields raw', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues', (body: { title: string; body: string }) => {
        expect(body.title).toBe('[bug] \\[click\\]\\(http://evil\\)');
        expect(body.body).toContain('[not escaped](x)');
        return true;
      })
      .reply(201, { number: 42 });

    await receiveDispatch(probot, {
      ...defaultTicket,
      subject: '[click](http://evil)',
      description: '[not escaped](x)',
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('passes numeric field values through and leaves unknown placeholders verbatim', async () => {
    mockInstallationToken();
    mockConfig(configFor({
      title: 'attempt {{attempts}} of {{undeclared}}',
      fields: { attempts: { required: true } },
    }));

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues', (body: { title: string }) => {
        expect(body.title).toBe('attempt 3 of {{undeclared}}');
        return true;
      })
      .reply(201, { number: 42 });

    await receiveDispatch(probot, { ticket_id: 'tkt_8f3a2c', attempts: 3, undeclared: 'never-seen' });

    expect(createScope.isDone()).toBe(true);
  });

  it('skips an absent optional field, leaving its placeholder verbatim', async () => {
    mockInstallationToken();
    mockConfig(configFor({
      title: 'subject: {{subject}}',
      fields: { subject: { escape: true } },
    }));

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues', (body: { title: string }) => {
        expect(body.title).toBe('subject: {{subject}}');
        return true;
      })
      .reply(201, { number: 42 });

    await receiveDispatch(probot, { ticket_id: 'tkt_8f3a2c', kind: 'bug' });

    expect(createScope.isDone()).toBe(true);
  });

  it('truncates the title to 256 characters and the body to fit the marker under the 65536 limit', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues', (body: { title: string; body: string }) => {
        expect(body.title).toHaveLength(256);
        expect(body.body).toHaveLength(65536);
        expect(body.body.endsWith(`\n\n${MARKER}`)).toBe(true);
        return true;
      })
      .reply(201, { number: 42 });

    await receiveDispatch(probot, {
      ...defaultTicket,
      subject: 'x'.repeat(300),
      description: 'y'.repeat(70000),
    });

    expect(createScope.isDone()).toBe(true);
  });

  it('throws when client_payload is null', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await expect(receiveDispatch(probot, null)).rejects.toThrow('client_payload is missing for "support-ticket"');
  });

  it('throws when a required field is missing', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const { subject, ...rest } = defaultTicket;

    await expect(receiveDispatch(probot, rest)).rejects.toThrow('Missing required field "subject" in client_payload for "support-ticket"');
    expect(subject).toBeDefined();
  });

  it('throws when a declared field is neither string nor number', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await expect(receiveDispatch(probot, { ...defaultTicket, subject: { nested: true } }))
      .rejects.toThrow('Field "subject" in client_payload for "support-ticket" must be a string or number, got object');
  });

  it('throws when the ref_field value is missing', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const { ticket_id, ...rest } = defaultTicket;

    await expect(receiveDispatch(probot, rest)).rejects.toThrow('ref_field "ticket_id" is missing from client_payload for "support-ticket" or is not a string or number');
    expect(ticket_id).toBeDefined();
  });

  it('throws when the ref value fails the charset check', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await expect(receiveDispatch(probot, { ...defaultTicket, ticket_id: 'has spaces!' }))
      .rejects.toThrow('ref_field "ticket_id" value "has spaces!" must match');
  });

  it('with dedupe on, skips creation when an issue already carries the marker', async () => {
    mockInstallationToken();
    mockConfig(configFor({ dedupe: true }));

    nock('https://api.github.com')
      .get('/repos/acme/support/issues')
      .query((q) => q['state'] === 'all' && q['labels'] === 'support' && q['per_page'] === '100')
      .reply(200, [
        { number: 7, body: 'unrelated' },
        { number: 8, body: `earlier report\n\n${MARKER}` },
      ]);

    await receiveDispatch(probot);

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('with dedupe on, creates the issue when no existing issue carries the marker', async () => {
    mockInstallationToken();
    mockConfig(configFor({ dedupe: true }));

    nock('https://api.github.com')
      .get('/repos/acme/support/issues')
      .query(() => true)
      .reply(200, [{ number: 7, body: null }]);

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues')
      .reply(201, { number: 42 });

    await receiveDispatch(probot);

    expect(createScope.isDone()).toBe(true);
  });

  it('with dedupe on and no static labels, lists without a labels filter', async () => {
    mockInstallationToken();
    mockConfig(configFor({ dedupe: true, labels: [] }));

    nock('https://api.github.com')
      .get('/repos/acme/support/issues')
      .query((q) => q['labels'] === undefined)
      .reply(200, []);

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues')
      .reply(201, { number: 42 });

    await receiveDispatch(probot);

    expect(createScope.isDone()).toBe(true);
  });

  it('skips the label and still creates the issue when the label_field value is not allowlisted', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues', (body: { labels: string[] }) => {
        expect(body.labels).toEqual(['support']);
        return true;
      })
      .reply(201, { number: 42 });

    await receiveDispatch(probot, { ...defaultTicket, kind: 'not-allowed' });

    expect(createScope.isDone()).toBe(true);
  });

  it('creates the issue without a labels key when no labels apply', async () => {
    mockInstallationToken();
    mockConfig(configFor({
      labels: [],
      label_field: undefined,
      label_allowlist: undefined,
    }));

    const createScope = nock('https://api.github.com')
      .post('/repos/acme/support/issues', (body: Record<string, unknown>) => {
        expect(body['labels']).toBeUndefined();
        return true;
      })
      .reply(201, { number: 42 });

    await receiveDispatch(probot);

    expect(createScope.isDone()).toBe(true);
  });

  it('does nothing when the event_type has no configuration', async () => {
    mockInstallationToken();
    mockConfig(configFor());

    await receiveDispatch(probot, defaultTicket, { eventType: 'unconfigured-type' });
  });

  it('does nothing when settings are absent', async () => {
    mockInstallationToken();
    mockConfig(JSON.stringify({ version: 1, subscribers: ['issue-intake'] }));

    await receiveDispatch(probot);
  });

  it('does nothing when issue-intake is not listed in subscribers', async () => {
    mockInstallationToken();
    mockConfig(configFor({}, ['welcome']));

    await receiveDispatch(probot);
  });

  it('does nothing when carson.yml is missing', async () => {
    mockInstallationToken();
    mockConfig(null);

    await receiveDispatch(probot);
  });
});
