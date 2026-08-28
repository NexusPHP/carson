/** Timestamp in the form GitHub search date qualifiers accept. */
export const searchTimestamp = (epochMs: number): string =>
  `${new Date(epochMs).toISOString().slice(0, 19)}+00:00`;
