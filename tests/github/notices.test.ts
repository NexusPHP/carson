import { describe, expect, it, vi } from 'vitest';
import { DIGEST_MARKER, findNotice, flushNotices, fromRestComment, isBotComment, isBotNode, isNoticeResolved, noticeMarker, queueNotice, reopenNotice, resolveNotice } from '../../src/github/notices.js';
import type { NoticeClient } from '../../src/github/notices.js';

const TARGET = { owner: 'acme', repo: 'widgets', number: 42 };

const stub = (liveBody?: string): { client: NoticeClient } & Record<'createComment' | 'getComment' | 'updateComment' | 'graphql', ReturnType<typeof vi.fn>> => {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 500 } });
  const getComment = vi.fn().mockResolvedValue({ data: { body: liveBody ?? null } });
  const updateComment = vi.fn().mockResolvedValue({});
  const graphql = vi.fn().mockResolvedValue({});
  const client: NoticeClient = { graphql, rest: { issues: { createComment, getComment, updateComment } } };

  return { client, createComment, getComment, updateComment, graphql };
};

const section = (id: string, body: string): string => `<!-- carson:${id}:start -->\n${body}\n${noticeMarker(id)}`;
const wrapped = (id: string, body: string, label = 'Resolved'): string =>
  `<!-- carson:${id}:start -->\n<details>\n<summary>${label}</summary>\n\n${body}\n</details>\n${noticeMarker(id)}`;
const digest = (...sections: string[]): string => `${sections.join('\n\n---\n\n')}\n\n${DIGEST_MARKER}`;

const bot = { user: { type: 'Bot' } };
const human = { user: { type: 'User' } };
const found = { commentId: 500, nodeId: 'IC_1', body: '' };

describe('queueNotice and flushNotices', () => {
  it('posts a lone notice as a plain comment ending with its marker', async () => {
    const { client, createComment } = stub();

    queueNotice(client, TARGET, { id: 'welcome', body: 'hi' });
    await flushNotices();

    expect(createComment).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', issue_number: 42, body: `hi\n\n${noticeMarker('welcome')}` });
  });

  it('posts several notices on one item as a single digest sorted by id', async () => {
    const { client, createComment } = stub();

    queueNotice(client, TARGET, { id: 'welcome', body: 'hi' });
    queueNotice(client, TARGET, { id: 'draft-policy', body: 'draft' });
    queueNotice(client, TARGET, { id: 'maintainer-edits', body: 'edits' });
    await flushNotices();

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: digest(section('draft-policy', 'draft'), section('maintainer-edits', 'edits'), section('welcome', 'hi')),
    }));
  });

  it('posts once per item and drains the queue', async () => {
    const { client, createComment } = stub();

    queueNotice(client, TARGET, { id: 'welcome', body: 'hi' });
    queueNotice(client, { ...TARGET, number: 43 }, { id: 'welcome', body: 'hi' });
    await flushNotices();
    await flushNotices();

    expect(createComment).toHaveBeenCalledTimes(2);
  });

  it('still posts the other items when one post fails, then rethrows', async () => {
    const { client, createComment } = stub();
    createComment.mockRejectedValueOnce(new Error('boom'));

    queueNotice(client, TARGET, { id: 'welcome', body: 'hi' });
    queueNotice(client, { ...TARGET, number: 43 }, { id: 'welcome', body: 'hi' });
    await expect(flushNotices()).rejects.toThrow('boom');
    await flushNotices();

    expect(createComment).toHaveBeenCalledTimes(2);
  });
});

describe('findNotice', () => {
  it('returns the latest bot comment ending with the marker and ignores forgeries', () => {
    const comments = [
      { ...bot, body: `old\n\n${noticeMarker('welcome')}` },
      { ...bot, body: `new\n\n${noticeMarker('welcome')}` },
      { ...human, body: `forged\n\n${noticeMarker('welcome')}` },
    ];

    expect(findNotice(comments, 'welcome', isBotComment)).toBe(comments[1]);
  });

  it('finds a section inside a bot digest, with CRLF line endings too', () => {
    const comments = [{ ...bot, body: digest(section('draft-policy', 'draft'), section('welcome', 'hi')).replace(/\n/g, '\r\n') }];

    expect(findNotice(comments, 'welcome', isBotComment)).toBe(comments[0]);
    expect(findNotice(comments, 'stale', isBotComment)).toBeUndefined();
  });

  it('ignores comments without a body', () => {
    expect(findNotice([{ ...bot, body: null }], 'welcome', isBotComment)).toBeUndefined();
  });
});

describe('author predicates and adapters', () => {
  it('recognize bot authors in REST and GraphQL shapes', () => {
    expect(isBotComment({ user: null })).toBe(false);
    expect(isBotNode({ author: { __typename: 'Bot' } })).toBe(true);
    expect(isBotNode({ author: null })).toBe(false);
  });

  it('adapts a REST comment to a FoundNotice', () => {
    expect(fromRestComment({ id: 7, node_id: 'IC_7', body: 'x' })).toEqual({ commentId: 7, nodeId: 'IC_7', body: 'x' });
  });
});

describe('isNoticeResolved', () => {
  it('reads the minimized flag for a standalone comment', () => {
    expect(isNoticeResolved('welcome', { ...found, body: `hi\n\n${noticeMarker('welcome')}`, isMinimized: true })).toBe(true);
    expect(isNoticeResolved('welcome', { ...found, body: `hi\n\n${noticeMarker('welcome')}` })).toBe(false);
  });

  it('reads the wrapper for a digest section', () => {
    expect(isNoticeResolved('welcome', { ...found, body: digest(wrapped('welcome', 'hi')) })).toBe(true);
    expect(isNoticeResolved('welcome', { ...found, body: digest(section('welcome', 'hi')) })).toBe(false);
    expect(isNoticeResolved('welcome', { ...found, body: digest(section('draft-policy', 'draft')) })).toBe(false);
  });
});

describe('resolveNotice', () => {
  it('minimizes a standalone comment', async () => {
    const { client, graphql, updateComment } = stub();

    await resolveNotice(client, TARGET, 'welcome', { ...found, body: `hi\n\n${noticeMarker('welcome')}` }, 'OUTDATED');

    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('minimizeComment'), { subjectId: 'IC_1', classifier: 'OUTDATED' });
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('wraps only its own section from the live body and never minimizes a digest', async () => {
    const live = digest(section('draft-policy', 'draft'), section('welcome', 'hi')).replace(/\n/g, '\r\n');
    const { client, graphql, getComment, updateComment } = stub(live);

    await resolveNotice(client, TARGET, 'welcome', { ...found, body: digest(section('welcome', 'stale snapshot')) }, 'OUTDATED');

    expect(getComment).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', comment_id: 500 });
    expect(updateComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      comment_id: 500,
      body: digest(section('draft-policy', 'draft'), wrapped('welcome', 'hi', 'Outdated')),
    });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('does nothing when the live section is already wrapped or missing', async () => {
    const snapshot = { ...found, body: digest(section('welcome', 'hi')) };
    const alreadyWrapped = stub(digest(wrapped('welcome', 'hi')));
    const missing = stub(digest(section('draft-policy', 'draft')));
    const emptyBody = stub();

    await resolveNotice(alreadyWrapped.client, TARGET, 'welcome', snapshot, 'RESOLVED');
    await resolveNotice(missing.client, TARGET, 'welcome', snapshot, 'RESOLVED');
    await resolveNotice(emptyBody.client, TARGET, 'welcome', snapshot, 'RESOLVED');

    expect(alreadyWrapped.updateComment).not.toHaveBeenCalled();
    expect(missing.updateComment).not.toHaveBeenCalled();
    expect(emptyBody.updateComment).not.toHaveBeenCalled();
  });

  it('treats a section whose closing marker was removed as missing', async () => {
    const { client, updateComment } = stub(`<!-- carson:welcome:start -->\nhi\n\n${DIGEST_MARKER}`);

    await resolveNotice(client, TARGET, 'welcome', { ...found, body: digest(section('welcome', 'hi')) }, 'RESOLVED');

    expect(updateComment).not.toHaveBeenCalled();
  });
});

describe('reopenNotice', () => {
  it('unminimizes a minimized standalone comment and leaves a visible one alone', async () => {
    const minimized = stub();
    const visible = stub();
    const body = `hi\n\n${noticeMarker('welcome')}`;

    await reopenNotice(minimized.client, TARGET, 'welcome', { ...found, body, isMinimized: true });
    await reopenNotice(visible.client, TARGET, 'welcome', { ...found, body });

    expect(minimized.graphql).toHaveBeenCalledWith(expect.stringContaining('unminimizeComment'), { subjectId: 'IC_1' });
    expect(visible.graphql).not.toHaveBeenCalled();
  });

  it('unwraps its section from the live digest body', async () => {
    const { client, graphql, updateComment } = stub(digest(wrapped('draft-policy', 'draft'), wrapped('welcome', 'hi')));

    await reopenNotice(client, TARGET, 'welcome', { ...found, body: digest(wrapped('welcome', 'hi')) });

    expect(graphql).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      comment_id: 500,
      body: digest(wrapped('draft-policy', 'draft'), section('welcome', 'hi')),
    });
  });

  it('does nothing when the live section is visible or missing', async () => {
    const snapshot = { ...found, body: digest(wrapped('welcome', 'hi')) };
    const visible = stub(digest(section('welcome', 'hi')));
    const missing = stub(digest(section('draft-policy', 'draft')));

    await reopenNotice(visible.client, TARGET, 'welcome', snapshot);
    await reopenNotice(missing.client, TARGET, 'welcome', snapshot);

    expect(visible.updateComment).not.toHaveBeenCalled();
    expect(missing.updateComment).not.toHaveBeenCalled();
  });
});
