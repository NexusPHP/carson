import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import app from '../src/app.js';
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { resetConfigCache } from '../src/configuration/cache.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const CONFIG = [
  'version: 1',
  'subscribers:',
  '  - maintainer-edits',
  '  - welcome',
  'settings:',
  '  welcome:',
  '    first_time:',
  '      pull_request: "Welcome {{user}}"',
  '  maintainer-edits:',
  '    message: "Allow edits, {{user}}"',
  '',
].join('\n');

const payload = {
  action: 'opened',
  installation: { id: 12345 },
  pull_request: {
    number: 42,
    draft: false,
    maintainer_can_modify: false,
    author_association: 'FIRST_TIME_CONTRIBUTOR',
    head: { sha: 'abc1234', ref: 'feature/widget', repo: { full_name: 'octocat/widgets' } },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: [],
  },
  repository: { owner: { login: 'acme' }, name: 'widgets', full_name: 'acme/widgets', default_branch: 'main' },
  sender: { type: 'User' },
};

describe('notice digest (via app)', () => {
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
      Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }),
    });
    await probot.load(app);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('folds two notices on one event into a single digest comment', async () => {
    nock('https://api.github.com')
      .post('/app/installations/12345/access_tokens')
      .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' })
      .get('/repos/acme/widgets/contents/.github%2Fcarson.yml')
      .reply(200, CONFIG)
      .get('/repos/acme/widgets/issues/42/comments')
      .query({ per_page: '100' })
      .reply(200, []);
    const bodies: string[] = [];
    const createScope = nock('https://api.github.com')
      .post('/repos/acme/widgets/issues/42/comments', (body: { body: string }) => {
        bodies.push(body.body);
        return true;
      })
      .reply(201, { id: 500 });
    const updateScope = nock('https://api.github.com')
      .patch('/repos/acme/widgets/issues/comments/500', (body: { body: string }) => {
        bodies.push(body.body);
        return true;
      })
      .reply(200, {});

    await probot.receive({ id: 'evt-digest', name: 'pull_request', payload: payload as never });

    expect(createScope.isDone()).toBe(true);
    expect(updateScope.isDone()).toBe(true);
    expect(bodies[0]).toMatch(/^(Welcome octocat\n\n<!-- carson:welcome -->|Allow edits, octocat\n\n<!-- carson:maintainer-edits -->)$/);
    expect(bodies[1]).toBe([
      '<!-- carson:maintainer-edits:start -->',
      'Allow edits, octocat',
      '<!-- carson:maintainer-edits -->',
      '',
      '---',
      '',
      '<!-- carson:welcome:start -->',
      'Welcome octocat',
      '<!-- carson:welcome -->',
      '',
      '<!-- carson:digest -->',
    ].join('\n'));
  });
});
