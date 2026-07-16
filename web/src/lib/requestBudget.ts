// Low-priority work must leave capacity for audio and interactive requests.
const IDLE_LIMIT = 4;
const PLAYING_LIMIT = 1;

let playbackActive = false;
let running = 0;
const pending: Array<() => void> = [];

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
    const next = pending.shift();
    if (!next) return;
    next();
  }
}

export function setPlaybackActive(active: boolean): void {
  playbackActive = active;
  drain();
}

export function runLowPriority<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.push(() => {
      running++;
      void work().then(resolve, reject).finally(() => {
        running--;
        drain();
      });
    });
    drain();
  });
}
