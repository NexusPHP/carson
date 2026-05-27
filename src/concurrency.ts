// Runs `fn` for every item in `items` with at most `concurrency` invocations
// in flight at once. Processes items in fixed-size chunks via Promise.all,
// so a slow item in a chunk blocks the next chunk from starting.

export const forEachConcurrent = async <T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
};
