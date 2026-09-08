import { type GraphqlClient, type MinimizeClassifier, minimizeComment, unminimizeComment } from './comments.js';

export const DIGEST_MARKER = '<!-- carson:digest -->';

export const noticeMarker = (id: string): string => `<!-- carson:${id} -->`;
const startMarker = (id: string): string => `<!-- carson:${id}:start -->`;

const LABELS: Record<MinimizeClassifier, string> = { RESOLVED: 'Resolved', OUTDATED: 'Outdated' };
const WRAPPED = /^<details>\n<summary>(?:Resolved|Outdated)<\/summary>\n\n([\s\S]*)\n<\/details>$/;

export interface NoticeTarget {
  owner: string;
  repo: string;
  number: number;
}

export interface NoticeClient extends GraphqlClient {
  rest: {
    issues: {
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<{ data: { id: number } }>;
      updateComment: (params: { owner: string; repo: string; comment_id: number; body: string }) => Promise<unknown>;
    };
  };
}

export interface FoundNotice {
  id: string;
  commentId: number;
  nodeId: string;
  body: string;
  inDigest: boolean;
}

interface Section {
  id: string;
  body: string;
}

interface Thread {
  commentId: number;
  sections: Section[];
}

const threads = new Map<string, Thread>();
let chain: Promise<unknown> = Promise.resolve();

const renderSection = ({ id, body }: Section): string => `${startMarker(id)}\n${body}\n${noticeMarker(id)}`;

const renderDigest = (sections: readonly Section[]): string =>
  `${[...sections].sort((a, b) => a.id.localeCompare(b.id)).map(renderSection).join('\n\n---\n\n')}\n\n${DIGEST_MARKER}`;

const write = async (client: NoticeClient, eventId: string, target: NoticeTarget, section: Section): Promise<void> => {
  const key = `${eventId}:${target.owner}/${target.repo}#${target.number}`;
  const thread = threads.get(key);
  const { owner, repo, number } = target;

  if (thread === undefined) {
    const { data } = await client.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: `${section.body}\n\n${noticeMarker(section.id)}`,
    });
    threads.set(key, { commentId: data.id, sections: [section] });

    return;
  }

  thread.sections.push(section);
  await client.rest.issues.updateComment({ owner, repo, comment_id: thread.commentId, body: renderDigest(thread.sections) });
};

// Handlers for one event run concurrently, so writes are serialized to let a
// second notice upgrade the first comment into a digest instead of racing it.
export const postNotice = async (client: NoticeClient, eventId: string, target: NoticeTarget, section: Section): Promise<void> => {
  const run = chain.then(async () => {
    await write(client, eventId, target, section);
  });
  chain = run.catch(() => undefined);

  await run;
};

const hasBody = <T extends { body?: string | null }>(comment: T): comment is T & { body: string } => typeof comment.body === 'string';

export const findNotice = <T extends { body?: string | null }>(
  comments: readonly T[],
  id: string,
  isBotAuthored: (comment: T) => boolean,
): { comment: T & { body: string }; inDigest: boolean } | undefined => {
  for (const comment of comments) {
    if (!isBotAuthored(comment) || !hasBody(comment)) {
      continue;
    }

    if (comment.body.endsWith(noticeMarker(id))) {
      return { comment, inDigest: false };
    }

    if (comment.body.endsWith(DIGEST_MARKER) && comment.body.includes(startMarker(id))) {
      return { comment, inDigest: true };
    }
  }

  return undefined;
};

const splitSection = (body: string, id: string): { before: string; inner: string; after: string } => {
  const start = body.indexOf(startMarker(id)) + startMarker(id).length + 1;
  const end = body.indexOf(noticeMarker(id), start) - 1;

  return { before: body.slice(0, start), inner: body.slice(start, end), after: body.slice(end) };
};

const sectionIds = (body: string): string[] =>
  [...body.matchAll(/<!-- carson:([\w-]+):start -->/g)].map((m) => m[1] as string);

const isWrapped = (body: string, id: string): boolean => WRAPPED.test(splitSection(body, id).inner);

export const isNoticeResolved = (found: FoundNotice, commentMinimized: boolean): boolean =>
  commentMinimized || (found.inDigest && isWrapped(found.body, found.id));

export const resolveNotice = async (client: NoticeClient, target: NoticeTarget, found: FoundNotice, classifier: MinimizeClassifier): Promise<void> => {
  if (!found.inDigest) {
    await minimizeComment(client, found.nodeId, classifier);

    return;
  }

  if (isWrapped(found.body, found.id)) {
    return;
  }

  const { before, inner, after } = splitSection(found.body, found.id);
  const body = `${before}<details>\n<summary>${LABELS[classifier]}</summary>\n\n${inner}\n</details>${after}`;
  await client.rest.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: found.commentId, body });

  if (sectionIds(body).every((id) => isWrapped(body, id))) {
    await minimizeComment(client, found.nodeId, classifier);
  }
};

export const reopenNotice = async (client: NoticeClient, target: NoticeTarget, found: FoundNotice, commentMinimized: boolean): Promise<void> => {
  if (commentMinimized) {
    await unminimizeComment(client, found.nodeId);
  }

  if (!found.inDigest || !isWrapped(found.body, found.id)) {
    return;
  }

  const { before, inner, after } = splitSection(found.body, found.id);
  const body = `${before}${(WRAPPED.exec(inner) as RegExpExecArray)[1] as string}${after}`;
  await client.rest.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: found.commentId, body });
};
