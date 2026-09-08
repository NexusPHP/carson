import { type GraphqlClient, type MinimizeClassifier, minimizeComment, unminimizeComment } from './comments.js';

export const DIGEST_MARKER = '<!-- carson:digest -->';

export const noticeMarker = (id: string): string => `<!-- carson:${id} -->`;
const startMarker = (id: string): string => `<!-- carson:${id}:start -->`;

const LABELS: Record<MinimizeClassifier, string> = { RESOLVED: 'Resolved', OUTDATED: 'Outdated' };
const WRAPPED = /^<details>\s*<summary>(?:Resolved|Outdated)<\/summary>\s*([\s\S]*?)\s*<\/details>$/;

export interface NoticeTarget {
  owner: string;
  repo: string;
  number: number;
}

export interface NoticeClient extends GraphqlClient {
  rest: {
    issues: {
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<unknown>;
      getComment: (params: { owner: string; repo: string; comment_id: number }) => Promise<{ data: { body?: string | null } }>;
      updateComment: (params: { owner: string; repo: string; comment_id: number; body: string }) => Promise<unknown>;
    };
  };
}

export interface FoundNotice {
  commentId: number;
  nodeId: string;
  body: string;
  isMinimized?: boolean;
}

interface Section {
  id: string;
  body: string;
}

interface Pending {
  client: NoticeClient;
  target: NoticeTarget;
  sections: Section[];
}

const pending = new Map<string, Pending>();

export const isBotComment = (comment: { user?: { type?: string } | null }): boolean => comment.user?.type === 'Bot';

export const isBotNode = (node: { author?: { __typename: string } | null }): boolean => node.author?.__typename === 'Bot';

export const fromRestComment = (comment: { id: number; node_id: string; body: string }): FoundNotice =>
  ({ commentId: comment.id, nodeId: comment.node_id, body: comment.body });

const normalize = (body: string): string => body.replace(/\r\n/g, '\n').trimEnd();

const renderDigest = (sections: readonly Section[]): string =>
  `${[...sections]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, body }) => `${startMarker(id)}\n${body}\n${noticeMarker(id)}`)
    .join('\n\n---\n\n')}\n\n${DIGEST_MARKER}`;

export const queueNotice = (client: NoticeClient, target: NoticeTarget, section: Section): void => {
  const key = `${target.owner}/${target.repo}#${target.number}`;
  const entry = pending.get(key) ?? { client, target, sections: [] };

  entry.sections.push(section);
  pending.set(key, entry);
};

const post = async ({ client, target, sections }: Pending): Promise<void> => {
  const [only] = sections;
  const body = sections.length === 1 && only !== undefined ? `${only.body}\n\n${noticeMarker(only.id)}` : renderDigest(sections);

  await client.rest.issues.createComment({ owner: target.owner, repo: target.repo, issue_number: target.number, body });
};

export const flushNotices = async (): Promise<void> => {
  const entries = [...pending.values()];
  pending.clear();

  const failed = (await Promise.allSettled(entries.map(post))).find((r): r is PromiseRejectedResult => r.status === 'rejected');

  if (failed !== undefined) {
    throw failed.reason;
  }
};

const hasBody = <T extends { body?: string | null }>(comment: T): comment is T & { body: string } => typeof comment.body === 'string';

export const findNotice = <T extends { body?: string | null }>(
  comments: readonly T[],
  id: string,
  isBotAuthored: (comment: T) => boolean,
): (T & { body: string }) | undefined => {
  for (const comment of [...comments].reverse()) {
    if (!isBotAuthored(comment) || !hasBody(comment)) {
      continue;
    }

    const body = normalize(comment.body);

    if (body.endsWith(noticeMarker(id)) || (body.endsWith(DIGEST_MARKER) && body.includes(startMarker(id)))) {
      return comment;
    }
  }

  return undefined;
};

const inDigest = (body: string): boolean => normalize(body).endsWith(DIGEST_MARKER);

const splitSection = (body: string, id: string): { before: string; inner: string; after: string } | null => {
  const start = body.indexOf(startMarker(id));

  if (start < 0) {
    return null;
  }

  const innerStart = start + startMarker(id).length;
  const end = body.indexOf(noticeMarker(id), innerStart);

  if (end < 0) {
    return null;
  }

  return { before: body.slice(0, innerStart), inner: body.slice(innerStart, end).trim(), after: body.slice(end) };
};

export const isNoticeResolved = (id: string, found: FoundNotice): boolean => {
  if (!inDigest(found.body)) {
    return found.isMinimized === true;
  }

  const section = splitSection(normalize(found.body), id);

  return section !== null && WRAPPED.test(section.inner);
};

const liveSection = async (
  client: NoticeClient,
  target: NoticeTarget,
  id: string,
  commentId: number,
): Promise<{ before: string; inner: string; after: string } | null> => {
  const { data } = await client.rest.issues.getComment({ owner: target.owner, repo: target.repo, comment_id: commentId });

  return splitSection(normalize(data.body ?? ''), id);
};

export const resolveNotice = async (
  client: NoticeClient,
  target: NoticeTarget,
  id: string,
  found: FoundNotice,
  classifier: MinimizeClassifier,
): Promise<void> => {
  if (!inDigest(found.body)) {
    await minimizeComment(client, found.nodeId, classifier);

    return;
  }

  const section = await liveSection(client, target, id, found.commentId);

  if (section === null || WRAPPED.test(section.inner)) {
    return;
  }

  const body = `${section.before}\n<details>\n<summary>${LABELS[classifier]}</summary>\n\n${section.inner}\n</details>\n${section.after}`;
  await client.rest.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: found.commentId, body });
};

export const reopenNotice = async (client: NoticeClient, target: NoticeTarget, id: string, found: FoundNotice): Promise<void> => {
  if (!inDigest(found.body)) {
    if (found.isMinimized === true) {
      await unminimizeComment(client, found.nodeId);
    }

    return;
  }

  const section = await liveSection(client, target, id, found.commentId);
  const match = section === null ? null : WRAPPED.exec(section.inner);

  if (section === null || match === null) {
    return;
  }

  const body = `${section.before}\n${match[1]}\n${section.after}`;
  await client.rest.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: found.commentId, body });
};
