// The issue-intake marker is a stable wire contract across the sender,
// Carson, and GitHub: parse leniently, emit canonically.

export interface IssueIntakeMarker {
  eventType: string;
  ref: string;
}

export const REF_REGEX = /^[\w.-]{1,64}$/;

// Anchored at the end of the body (trailing whitespace tolerated) so a
// marker echoed mid-body via interpolated content never matches.
const MARKER_END_REGEX = /<!--\s*carson:issue-intake:(.+):([\w.-]{1,64})\s*-->\s*$/;

export const buildIssueIntakeMarker = (eventType: string, ref: string): string =>
  `<!-- carson:issue-intake:${eventType}:${ref} -->`;

export const parseIssueIntakeMarker = (body: string | null | undefined): IssueIntakeMarker | null => {
  if (body === null || body === undefined) {
    return null;
  }

  const match = MARKER_END_REGEX.exec(body);

  if (match === null) {
    return null;
  }

  const [, eventType, ref] = match;

  return { eventType: eventType.trim(), ref };
};
