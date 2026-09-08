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
const PR_NUMBER = 42;

const mockInstallationToken = (): void => {
  nock('https://api.github.com')
    .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
    .reply(201, { token: 'inst-token', expires_at: '2099-01-01T00:00:00Z' });
};

const mockConfig = (yaml: string): void => {
  nock('https://api.github.com')
    .get('/repos/acme/widgets/contents/.github%2Fcarson.yml')
    .reply(200, yaml);
};

interface MilestoneInput {
  number: number;
  title: string;
  due_on?: string | null;
}

const mockListMilestones = (milestones: MilestoneInput[]): nock.Scope => {
  return nock('https://api.github.com')
    .get('/repos/acme/widgets/milestones')
    .query({ state: 'open', per_page: '100' })
    .reply(200, milestones.map((m) => ({ number: m.number, title: m.title, due_on: m.due_on ?? null, state: 'open' })));
};

const mockSetMilestone = (number: number): nock.Scope => {
  return nock('https://api.github.com')
    .patch(`/repos/acme/widgets/issues/${PR_NUMBER}`, (body: { milestone: number }) => {
      expect(body).toEqual({ milestone: number });
      return true;
    })
    .reply(200, {});
};

interface PayloadOverrides {
  action?: 'opened' | 'ready_for_review' | 'labeled' | 'edited';
  draft?: boolean;
  base?: string;
  labels?: string[];
  milestone?: { number: number; title: string } | null;
  changes?: Record<string, unknown>;
}

const prPayload = (overrides: PayloadOverrides = {}): Record<string, unknown> => ({
  action: overrides.action ?? 'opened',
  installation: { id: INSTALLATION_ID },
  pull_request: {
    number: PR_NUMBER,
    draft: overrides.draft ?? false,
    head: { sha: 'abc1234', ref: 'feature/widget' },
    base: { ref: overrides.base ?? 'main' },
    user: { login: 'octocat' },
    title: 'Fix the thing',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
    milestone: overrides.milestone ?? null,
  },
  ...(overrides.changes === undefined ? {} : { changes: overrides.changes }),
  repository: { owner: { login: 'acme' }, name: 'widgets' },
  sender: { type: 'User' },
});

const configWith = (rulesYaml: string[], extra: string[] = []): string => [
  'version: 1',
  'subscribers:',
  '  - milestone',
  'settings:',
  '  milestone:',
  ...extra,
  '    rules:',
  ...rulesYaml,
  '',
].join('\n');

const BRANCH_RULES = [
  '      - labels: [waiting code merge]',
  '        milestone: next',
  '      - base: "^release/(\\\\d+\\\\.\\\\d+)$"',
  '        milestone: "v$1"',
  '      - base: "^main$"',
  '        milestone: next-open',
];

const MILESTONES: MilestoneInput[] = [
  { number: 1, title: 'v1.4', due_on: '2026-10-01T00:00:00Z' },
  { number: 2, title: 'v1.5', due_on: '2026-12-01T00:00:00Z' },
  { number: 3, title: 'next' },
];

describe('milestone subscriber (via app)', () => {
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

  it('derives the milestone from a base-branch capture group', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones(MILESTONES);
    const setScope = mockSetMilestone(2);

    await probot.receive({
      id: 'evt-ms-capture',
      name: 'pull_request',
      payload: prPayload({ base: 'release/1.5' }) as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('picks the earliest open milestone by due date for next-open', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones([MILESTONES[1] as MilestoneInput, MILESTONES[2] as MilestoneInput, MILESTONES[0] as MilestoneInput]);
    const setScope = mockSetMilestone(1);

    await probot.receive({
      id: 'evt-ms-next-open',
      name: 'pull_request',
      payload: prPayload({ base: 'main' }) as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('orders next-open candidates without a due date by version-aware title', async () => {
    mockInstallationToken();
    mockConfig(configWith(['      - milestone: next-open']));
    mockListMilestones([
      { number: 10, title: 'v1.10' },
      { number: 9, title: 'v1.9' },
      { number: 20, title: 'v2.0', due_on: '2027-01-01T00:00:00Z' },
    ]);
    const setScope = mockSetMilestone(20);

    await probot.receive({
      id: 'evt-ms-next-open-title',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('falls back to title order when no milestone has a due date', async () => {
    mockInstallationToken();
    mockConfig(configWith(['      - milestone: next-open']));
    mockListMilestones([
      { number: 10, title: 'v1.10' },
      { number: 9, title: 'v1.9' },
    ]);
    const setScope = mockSetMilestone(9);

    await probot.receive({
      id: 'evt-ms-title-order',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('pins a fixed milestone when a label rule matches first', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones(MILESTONES);
    const setScope = mockSetMilestone(3);

    await probot.receive({
      id: 'evt-ms-label',
      name: 'pull_request',
      payload: prPayload({ action: 'labeled', base: 'release/1.5', labels: ['waiting code merge'] }) as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('does nothing when no rule matches', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones(MILESTONES);

    await probot.receive({
      id: 'evt-ms-no-match',
      name: 'pull_request',
      payload: prPayload({ base: 'develop' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when the derived milestone does not exist', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones(MILESTONES);

    await probot.receive({
      id: 'evt-ms-missing',
      name: 'pull_request',
      payload: prPayload({ base: 'release/9.9' }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when next-open has no open milestone', async () => {
    mockInstallationToken();
    mockConfig(configWith(['      - milestone: next-open']));
    mockListMilestones([]);

    await probot.receive({
      id: 'evt-ms-no-open',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('leaves an existing milestone alone by default', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones(MILESTONES);

    await probot.receive({
      id: 'evt-ms-existing',
      name: 'pull_request',
      payload: prPayload({ base: 'release/1.5', milestone: { number: 1, title: 'v1.4' } }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('replaces an existing milestone when override is true', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES, ['    override: true']));
    mockListMilestones(MILESTONES);
    const setScope = mockSetMilestone(2);

    await probot.receive({
      id: 'evt-ms-override',
      name: 'pull_request',
      payload: prPayload({ base: 'release/1.5', milestone: { number: 1, title: 'v1.4' } }) as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('makes no call when the PR already has the wanted milestone', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones(MILESTONES);

    await probot.receive({
      id: 'evt-ms-same',
      name: 'pull_request',
      payload: prPayload({ base: 'release/1.5', milestone: { number: 2, title: 'v1.5' } }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('follows a retarget when the current milestone was derived from the old base', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones(MILESTONES);
    const setScope = mockSetMilestone(2);

    await probot.receive({
      id: 'evt-ms-retarget',
      name: 'pull_request',
      payload: prPayload({
        action: 'edited',
        base: 'release/1.5',
        milestone: { number: 1, title: 'v1.4' },
        changes: { base: { ref: { from: 'release/1.4' }, sha: { from: 'old' } } },
      }) as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('keeps a hand-set milestone across a retarget', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));
    mockListMilestones(MILESTONES);

    await probot.receive({
      id: 'evt-ms-retarget-manual',
      name: 'pull_request',
      payload: prPayload({
        action: 'edited',
        base: 'release/1.5',
        milestone: { number: 3, title: 'next' },
        changes: { base: { ref: { from: 'release/1.4' }, sha: { from: 'old' } } },
      }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores edits that do not change the base branch', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));

    await probot.receive({
      id: 'evt-ms-edit-title',
      name: 'pull_request',
      payload: prPayload({ action: 'edited', changes: { title: { from: 'old' } } }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('skips draft PRs on open and handles them on ready_for_review', async () => {
    mockInstallationToken();
    mockConfig(configWith(BRANCH_RULES));

    await probot.receive({
      id: 'evt-ms-draft',
      name: 'pull_request',
      payload: prPayload({ base: 'release/1.5', draft: true }) as never,
    });

    expect(nock.pendingMocks()).toEqual([]);

    mockListMilestones(MILESTONES);
    const setScope = mockSetMilestone(2);

    await probot.receive({
      id: 'evt-ms-ready',
      name: 'pull_request',
      payload: prPayload({ action: 'ready_for_review', base: 'release/1.5' }) as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('skips a rule with an invalid regex and continues to the next', async () => {
    mockInstallationToken();
    mockConfig(configWith([
      '      - base: "("',
      '        milestone: broken',
      '      - milestone: next',
    ]));
    mockListMilestones(MILESTONES);
    const setScope = mockSetMilestone(3);

    await probot.receive({
      id: 'evt-ms-bad-regex',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('substitutes an empty string for a capture group that did not participate', async () => {
    mockInstallationToken();
    mockConfig(configWith([
      '      - base: "^(main)|(trunk)$"',
      '        milestone: "$1$2"',
    ]));
    mockListMilestones([{ number: 7, title: 'main' }]);
    const setScope = mockSetMilestone(7);

    await probot.receive({
      id: 'evt-ms-empty-group',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(setScope.isDone()).toBe(true);
  });

  it('does nothing when no rules are configured', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - milestone\n');

    await probot.receive({
      id: 'evt-ms-no-rules',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('does nothing when milestone is not enabled', async () => {
    mockInstallationToken();
    mockConfig('version: 1\nsubscribers:\n  - welcome\n');

    await probot.receive({
      id: 'evt-ms-disabled',
      name: 'pull_request',
      payload: prPayload() as never,
    });

    expect(nock.pendingMocks()).toEqual([]);
  });
});
