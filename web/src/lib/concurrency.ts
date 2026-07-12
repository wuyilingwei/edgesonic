// Bounded-concurrency pool: runs `worker` over every item with at most
// `limit` in flight at once, instead of a fully sequential for-await loop.
// Each lane re-checks `isCancelled` before picking up its next item so a
// cancel flag still takes effect promptly even mid-batch. Does not cap the
// total item count — callers are expected to have already paginated/
// collected the full item list; this only bounds how many run at once.
export async function mapConcurrent<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  isCancelled?: () => boolean,
): Promise<void> {
  let next = 0;
  async function lane(): Promise<void> {
    for (;;) {
      if (isCancelled?.()) return;
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
}
