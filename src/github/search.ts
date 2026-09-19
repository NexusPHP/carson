/** Timestamp for a search date qualifier. Octokit sends a `+` in `q` as a space, so the offset form cannot be used. */
export const searchTimestamp = (epochMs: number): string =>
  `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
