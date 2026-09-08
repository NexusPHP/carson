import { describe, expect, it, vi } from 'vitest';
import { DIGEST_MARKER, findNotice, isNoticeResolved, noticeMarker, postNotice, reopenNotice, resolveNotice } from '../../src/github/notices.js';
import type { NoticeClient } from '../../src/github/notices.js';

const TARGET = { owner: 'acme', repo: 'widgets', number: 42 };

interface Stub {
  client: NoticeClient;
  createComment: ReturnType<typeof vi.fn>;
  updateComment: ReturnType<typeof vi.fn>;
  graphql: ReturnType<typeof vi.fn>;
}

const stub = (): Stub => {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 500 } });
  const updateComment = vi.fn().mockResolvedValue({});
  const graphql = vi.fn().mockResolvedValue({});

  return { client: { graphql, rest: { issues: { createComment, updateComment } } } as unknown as NoticeClient, createComment, updateComment, graphql };
};

let delivery = 0;
const eventId = (): string => `evt-${++delivery}`;

const section = (id: string, body: string): string => `<!-- carson:${id}:start -->\n${body}\n${noticeMarker(id)}`;
const wrapped = (id: string, body: string, label = 'Resolved'): string =>
  `<!-- carson:${id}:start -->\n<details>\n<summary>${label}</summary>\n\n${body}\n</details>\n${noticeMarker(id)}`;
const digest = (...sections: string[]): string => `${sections.join('\n\n---\n\n')}\n\n${DIGEST_MARKER}`;

const bot = { user: { type: 'Bot' } };
const human = { user: { type: 'User' } };
const isBot = (c: { user: { type: string } }): boolean => c.user.type === 'Bot';

describe('postNotice', () => {
  it('posts a standalone comment for the first notice on an item', async () => {
    const { client, createComment, updateComment } = stub();

    await postNotice(client, eventId(), TARGET, { id: 'welcome', body: 'hi' });

    expect(createComment).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', issue_number: 42, body: `hi\n\n${noticeMarker('welcome')}` });
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('upgrades the comment into a digest sorted by id when a second notice arrives in the same event', async () => {
    const { client, createComment, updateComment } = stub();
    const id = eventId();

    await Promise.all([
      postNotice(client, id, TARGET, { id: 'welcome', body: 'hi' }),
      postNotice(client, id, TARGET, { id: 'draft-policy', body: 'draft' }),
    ]);
    await postNotice(client, id, TARGET, { id: 'maintainer-edits', body: 'edits' });

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenLastCalledWith({
      owner: 'acme',
      repo: 'widgets',
      comment_id: 500,
      body: digest(section('draft-policy', 'draft'), section('maintainer-edits', 'edits'), section('welcome', 'hi')),
    });
  });

  it('keeps notices from different events and items apart', async () => {
    const { client, createComment, updateComment } = stub();
    const id = eventId();

    await postNotice(client, id, TARGET, { id: 'welcome', body: 'hi' });
    await postNotice(client, id, { ...TARGET, number: 43 }, { id: 'welcome', body: 'hi' });
    await postNotice(client, eventId(), TARGET, { id: 'welcome', body: 'hi' });

    expect(createComment).toHaveBeenCalledTimes(3);
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('keeps serving later notices after one fails', async () => {
    const { client, createComment } = stub();
    createComment.mockRejectedValueOnce(new Error('boom'));

    await expect(postNotice(client, eventId(), TARGET, { id: 'welcome', body: 'hi' })).rejects.toThrow('boom');
    await postNotice(client, eventId(), TARGET, { id: 'welcome', body: 'hi' });

    expect(createComment).toHaveBeenCalledTimes(2);
  });
});

describe('findNotice', () => {
  it('finds a standalone bot comment ending with the marker', () => {
    const comments = [{ ...human, body: `forged\n\n${noticeMarker('welcome')}` }, { ...bot, body: `hi\n\n${noticeMarker('welcome')}` }];

    expect(findNotice(comments, 'welcome', isBot)).toEqual({ comment: comments[1], inDigest: false });
  });

  it('finds a section inside a bot digest', () => {
    const comments = [{ ...bot, body: digest(section('draft-policy', 'draft'), section('welcome', 'hi')) }];

    expect(findNotice(comments, 'welcome', isBot)).toEqual({ comment: comments[0], inDigest: true });
    expect(findNotice(comments, 'stale', isBot)).toBeUndefined();
  });

  it('ignores comments without a body', () => {
    expect(findNotice([{ ...bot, body: null }], 'welcome', isBot)).toBeUndefined();
  });
});

describe('isNoticeResolved', () => {
  const found = { id: 'welcome', commentId: 500, nodeId: 'IC_1', inDigest: true, body: '' };

  it('is true when the comment is minimized', () => {
    expect(isNoticeResolved({ ...found, inDigest: false }, true)).toBe(true);
  });

  it('is true when the section is wrapped', () => {
    expect(isNoticeResolved({ ...found, body: digest(wrapped('welcome', 'hi')) }, false)).toBe(true);
    expect(isNoticeResolved({ ...found, body: digest(section('welcome', 'hi')) }, false)).toBe(false);
  });
});

describe('resolveNotice', () => {
  const found = { id: 'welcome', commentId: 500, nodeId: 'IC_1', inDigest: false, body: `hi\n\n${noticeMarker('welcome')}` };

  it('minimizes a standalone comment', async () => {
    const { client, graphql, updateComment } = stub();

    await resolveNotice(client, TARGET, found, 'OUTDATED');

    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('minimizeComment'), { subjectId: 'IC_1', classifier: 'OUTDATED' });
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('wraps only its own section and leaves the comment visible while others stand', async () => {
    const { client, graphql, updateComment } = stub();
    const body = digest(section('draft-policy', 'draft'), section('welcome', 'hi'));

    await resolveNotice(client, TARGET, { ...found, inDigest: true, body }, 'OUTDATED');

    expect(updateComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      comment_id: 500,
      body: digest(section('draft-policy', 'draft'), wrapped('welcome', 'hi', 'Outdated')),
    });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('minimizes the whole comment once every section is wrapped', async () => {
    const { client, graphql, updateComment } = stub();
    const body = digest(wrapped('draft-policy', 'draft'), section('welcome', 'hi'));

    await resolveNotice(client, TARGET, { ...found, inDigest: true, body }, 'RESOLVED');

    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('minimizeComment'), { subjectId: 'IC_1', classifier: 'RESOLVED' });
  });

  it('does nothing for a section that is already wrapped', async () => {
    const { client, graphql, updateComment } = stub();

    await resolveNotice(client, TARGET, { ...found, inDigest: true, body: digest(wrapped('welcome', 'hi')) }, 'RESOLVED');

    expect(updateComment).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe('reopenNotice', () => {
  const found = { id: 'welcome', commentId: 500, nodeId: 'IC_1', inDigest: false, body: `hi\n\n${noticeMarker('welcome')}` };

  it('unminimizes a minimized standalone comment', async () => {
    const { client, graphql, updateComment } = stub();

    await reopenNotice(client, TARGET, found, true);

    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('unminimizeComment'), { subjectId: 'IC_1' });
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('unwraps its section in a digest and unminimizes the comment when needed', async () => {
    const { client, graphql, updateComment } = stub();
    const body = digest(wrapped('draft-policy', 'draft'), wrapped('welcome', 'hi'));

    await reopenNotice(client, TARGET, { ...found, inDigest: true, body }, true);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      comment_id: 500,
      body: digest(wrapped('draft-policy', 'draft'), section('welcome', 'hi')),
    });
  });

  it('does nothing for a visible section in a visible digest', async () => {
    const { client, graphql, updateComment } = stub();

    await reopenNotice(client, TARGET, { ...found, inDigest: true, body: digest(section('welcome', 'hi')) }, false);

    expect(graphql).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
  });
});
