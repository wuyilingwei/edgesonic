// Low-priority work must leave capacity for audio and interactive requests.
const IDLE_LIMIT = 4;
const PLAYING_LIMIT = 1;
// A slot is handed back after this long even when the work never settles, so a
// single stalled request cannot deadlock the queue at PLAYING_LIMIT.
const SLOT_TIMEOUT_MS = 20_000;

// "prefetch" is time-critical work for the track about to play and always
// drains ahead of "background" bulk work such as media-library cover art.
export type BudgetPriority = "prefetch" | "background";

let playbackActive = false;
let running = 0;
const queues: Record<BudgetPriority, Array<() => void>> = { prefetch: [], background: [] };

function limit(): number {
  if (playbackActive) return PLAYING_LIMIT;
  const connection = (navigator as Navigator & {
    connection?: { effectiveType?: string; saveData?: boolean };
  }).connection;
  if (connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return 1;
  if (connection?.effectiveType === "3g") return 2;
  return IDLE_LIMIT;
}

function drain(): void {
  while (running < limit()) {
    const next = queues.prefetch.shift() ?? queues.background.shift();
    if (!next) return;
    next();
  }
}

export function setPlaybackActive(active: boolean): void {
  playbackActive = active;
  drain();
}

export function runLowPriority<T>(
  work: () => Promise<T>,
  priority: BudgetPriority = "background",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queues[priority].push(() => {
      running++;
      let released = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        if (released) return;
        released = true;
        if (timer !== undefined) clearTimeout(timer);
        running--;
        drain();
      };
      timer = setTimeout(release, SLOT_TIMEOUT_MS);
      void work().then(resolve, reject).finally(release);
    });
    drain();
  });
}
