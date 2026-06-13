// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// 052 — Browser worker pool client (Pinia store).
// ---------------------------------------------------------------------------
// The store is registered on app start (main.ts). Whenever the page is
// visible AND `enabled` is true AND the user has level ≥ 2, we hit
// /edgesonic/work/poll every `pollIntervalMs` (default 5 min) and drain the
// returned tasks via the Web Worker entry in workers/taskExecutor.ts.
//
// Lifecycle:
//   - login → start()  → set interval + immediately drain once
//   - visibility hidden → stop() (browsers throttle setInterval anyway, but
//                                  explicit stop saves us a noisy poll on
//                                  reactivate when the cached interval is stale)
//   - visibility visible → start() if enabled
//   - logout → stop() + reset stats
//
// Stats are live for the Settings UI. The current task type is shown so an
// admin can confirm the pool is actually doing work.

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useAuth } from "../api";

interface PollResponse {
  ok: boolean;
  tasks?: PolledTask[];
  error?: string;
}
interface PolledTask {
  id: string;
  taskType: string;
  payload: Record<string, unknown>;
  requiredCaps: string[];
  priority: number;
  attempts: number;
  maxAttempts: number;
  claimedAt: number;
  heartbeatAt: number;
}

const STORAGE_KEY = "participate_work";
const DEFAULT_POLL_MS = 5 * 60 * 1000;

// 078 — error message ceiling matches the worker-side clamp in
// taskExecutor.ts AND the server-side clamp in /work/submit. Three layers of
// 500-byte truncation is intentional: each layer protects its own surface
// from runaway error strings (memory churn on the worker, postMessage cost
// on the main thread, D1 column blowup on the server).
const ERR_LIMIT = 500;

/**
 * 078 — Build the error string we send to /work/submit when a worker fails.
 *
 * Prefix carries enough context to grep work_queue.error_message rows:
 *   "[metadata:abcd1234] HTTP 503 from r2-stream"
 *
 * The raw arg is intentionally `unknown` so callers can pass either Error
 * (from try/catch), ErrorEvent (from worker error listener), or a string
 * fallback. Exported so the unit test can exercise the formatting without
 * spinning up a Worker.
 */
export function formatTaskError(
  task: { id: string; task_type: string },
  raw: unknown,
): string {
  let body: string;
  if (raw instanceof Error) {
    body = raw.message || raw.toString();
  } else if (typeof raw === "string") {
    body = raw;
  } else if (raw && typeof raw === "object" && "message" in raw && typeof (raw as { message: unknown }).message === "string") {
    body = (raw as { message: string }).message;
  } else {
    body = String(raw);
  }
  if (!body) body = "worker reported empty error";
  const prefixed = `[${task.task_type}:${task.id.slice(0, 8)}] ${body}`;
  return prefixed.length > ERR_LIMIT ? prefixed.slice(0, ERR_LIMIT) : prefixed;
}

export const useWorkerPool = defineStore("workerPool", () => {
  const { level, edgesonicFetch, edgesonicPost, restUrl } = useAuth();

  // --- reactive state ---
  // Opt-in: persists in localStorage so the user's preference survives reload.
  // The Settings UI is the only place that flips this; the store reads it on
  // start.
  const enabled = ref(localStorage.getItem(STORAGE_KEY) !== "false");
  // Run-time poll cadence; hydrated from features/list once on start so the
  // server-side default propagates. We never poll faster than 30s even if
  // mis-configured — feature_strings.worker_poll_interval_seconds is clamped
  // 30..3600 by the worker validator.
  const pollIntervalMs = ref(DEFAULT_POLL_MS);
  const stats = ref({ completed: 0, failed: 0, currentTaskType: "" });
  const lastError = ref<string | null>(null);
  const lastPollAt = ref<number>(0);

  // 056 — surface state Files.vue needs to render the work-queue HUD.
  // - `recent` is a small FIFO ring (≤ 5) of just-finished tasks so the UI
  //   can show task chips without re-querying the server.
  // - `completedSamples` powers the speed estimator: we push one entry per
  //   completed/failed task and compute completions/min over the last 5min.
  //   Memory cap is the SAMPLE_LIMIT below (older entries get dropped).
  // - `isWorking` is true any time the pool is busy (either running a task
  //   or mid-poll) so the HUD can hide itself when truly idle.
  interface RecentTask {
    id: string;
    taskType: string;
    fileName: string;
    status: "ok" | "fail";
    finishedAt: number;
    error?: string;
  }
  const RECENT_LIMIT = 5;
  const SPEED_WINDOW_MS = 5 * 60 * 1000;
  const SAMPLE_LIMIT = 120;
  const recent = ref<RecentTask[]>([]);
  const completedSamples = ref<Array<{ ts: number; count: number }>>([]);

  function pushRecent(entry: RecentTask): void {
    recent.value.unshift(entry);
    if (recent.value.length > RECENT_LIMIT) recent.value.length = RECENT_LIMIT;
  }
  function recordSample(): void {
    completedSamples.value.push({ ts: Date.now(), count: stats.value.completed });
    if (completedSamples.value.length > SAMPLE_LIMIT) {
      completedSamples.value.splice(0, completedSamples.value.length - SAMPLE_LIMIT);
    }
  }
  // Best-effort: PolledTask payloads from the scan dispatcher include either
  // `sourceUri` or `storageUri`. We take the tail segment so the recent-list
  // shows something human-readable instead of an instance UUID.
  function fileNameFrom(task: PolledTask): string {
    const payload = task.payload || {};
    const candidate =
      typeof payload.sourceUri === "string" ? payload.sourceUri :
      typeof payload.storageUri === "string" ? payload.storageUri :
      "";
    if (candidate) {
      const tail = candidate.split("/").filter(Boolean).pop();
      if (tail) return tail;
    }
    return task.id.slice(0, 8);
  }

  // capabilities — what this browser can actually execute. The Worker poll
  // endpoint takes a `caps=` parameter; we filter on the server using these.
  const caps = computed<string[]>(() => {
    const c: string[] = ["music-metadata", "scrape"];
    // ffmpeg.wasm needs SharedArrayBuffer, which requires the page to be
    // cross-origin isolated. 065 ships the COOP/COEP/CORP middleware that
    // flips `crossOriginIsolated = true`. We gate on both the global symbol
    // (engine support) AND the runtime flag (page actually isolated) — a
    // browser may expose SharedArrayBuffer but refuse to materialise its
    // shared memory backing when isolation is off.
    if (
      typeof SharedArrayBuffer !== "undefined" &&
      typeof globalThis !== "undefined" &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
    ) {
      c.push("ffmpeg");
    }
    return c;
  });

  // Only level ≥ 2 may participate. Lower levels get the toggle disabled in
  // Settings, but we double-check here in case someone localStorage-hacks the
  // flag — the server permission check (participate_work) is the real gate.
  const eligible = computed(() => level.value >= 2);

  // --- internal state ---
  let intervalId: number | null = null;
  let draining = false;
  // 056 — `draining` is module-local, not reactive; mirror it into a ref so
  // `isWorking` updates when poll-and-drain starts/stops without a task.
  const isDraining = ref(false);

  // 056 — true whenever the pool has *something* to show in the HUD: either
  // a task is currently executing (currentTaskType is non-empty) or we're
  // mid-poll. Falls back to false when fully idle so Files.vue can collapse
  // the work-queue block.
  const isWorking = computed(() =>
    !!stats.value.currentTaskType || isDraining.value,
  );

  // 056 — completions/min averaged over the last SPEED_WINDOW_MS. Returns
  // null when there's < 2 samples or the window is too short (UI shows "--").
  const speedPerMin = computed<number | null>(() => {
    const samples = completedSamples.value;
    if (samples.length < 2) return null;
    const now = Date.now();
    const cutoff = now - SPEED_WINDOW_MS;
    // Find the oldest sample inside the window (or fall back to the first
    // one — a low-throughput pool can have samples spread > 5min apart).
    let oldest = samples[0];
    for (const s of samples) {
      if (s.ts >= cutoff) { oldest = s; break; }
    }
    const elapsed = now - oldest.ts;
    if (elapsed < 1000) return null;
    const delta = stats.value.completed - oldest.count;
    if (delta <= 0) return 0;
    return Math.round((delta * 60_000) / elapsed * 10) / 10;
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  function start(): void {
    if (intervalId !== null) return;
    if (!enabled.value || !eligible.value) return;
    intervalId = window.setInterval(pollAndDrain, pollIntervalMs.value);
    // Kick off one drain immediately so the user sees the first task move
    // through the UI without waiting a full interval. Errors are swallowed
    // and surfaced via lastError.
    void pollAndDrain();
  }

  function stop(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function setEnabled(v: boolean): void {
    enabled.value = v;
    localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
    if (v) start(); else stop();
  }

  // The Settings sub-block "force poll" button calls this. Bypasses the
  // interval so the admin can verify the queue is alive.
  async function pollNow(): Promise<void> {
    await pollAndDrain();
  }

  // ---------------------------------------------------------------------------
  // Poll + drain
  // ---------------------------------------------------------------------------
  async function pollAndDrain(): Promise<void> {
    if (draining) return;            // serialise: never two drains at once
    if (!enabled.value || !eligible.value) return;
    if (typeof document !== "undefined" && document.hidden) return;
    draining = true;
    isDraining.value = true;
    lastError.value = null;
    lastPollAt.value = Date.now();
    try {
      const text = await edgesonicFetch("work/poll", {
        caps: caps.value.join(","),
        limit: "5",
      });
      const data: PollResponse = JSON.parse(text);
      if (!data.ok) throw new Error(data.error || "poll rejected");
      for (const task of data.tasks || []) {
        await executeOne(task);
      }
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e);
    } finally {
      stats.value.currentTaskType = "";
      draining = false;
      isDraining.value = false;
    }
  }

  async function executeOne(task: PolledTask): Promise<void> {
    stats.value.currentTaskType = task.taskType;
    let worker: Worker | null = null;
    try {
      // The Worker module-bundle is shipped lazily by Vite when this code
      // runs. The `new URL(...)` form is the Vite-supported syntax for
      // typed Web Worker imports (no glob, no string-only).
      worker = new Worker(
        new URL("../workers/taskExecutor.ts", import.meta.url),
        { type: "module" },
      );

      // For metadata tasks the worker can't fetch a logical `webdav://` URI
      // directly. We hand it a signed /rest/stream URL the main thread built
      // so the credentials stay in the main-thread origin.
      const augmented: PolledTask = JSON.parse(JSON.stringify(task));
      if (task.taskType === "metadata") {
        const instanceId = String(task.payload.instanceId || "");
        if (instanceId) {
          augmented.payload.streamUrl = restUrl("stream", { id: instanceId });
        }
      }

      const result = await runWorkerOnce(worker, augmented);
      // Submit success path.
      await edgesonicPost("work/submit", { id: task.id, result });
      stats.value.completed++;
      // 056 — surface to Files.vue HUD.
      pushRecent({
        id: task.id,
        taskType: task.taskType,
        fileName: fileNameFrom(task),
        status: "ok",
        finishedAt: Date.now(),
      });
      recordSample();
    } catch (e) {
      // 078 — wrap the raw error with task context so admins reading
      // work_queue.error_message can spot which task failed without joining
      // back through result_json. The 500-char ceiling is enforced inside
      // formatTaskError; /work/submit also clamps server-side as belt-and-
      // braces.
      const msg = formatTaskError(
        { id: task.id, task_type: task.taskType },
        e,
      );
      // submit error so the row goes back to queued (or to failed if exhausted).
      // We deliberately ignore the submit's own response — if the network is
      // also down we'll let the reclaim sweep catch the row.
      try { await edgesonicPost("work/submit", { id: task.id, error: msg }); } catch { /* ignore */ }
      stats.value.failed++;
      pushRecent({
        id: task.id,
        taskType: task.taskType,
        fileName: fileNameFrom(task),
        status: "fail",
        finishedAt: Date.now(),
        error: msg,
      });
      recordSample();
    } finally {
      if (worker) worker.terminate();
    }
  }

  // One-shot worker round-trip. Resolves with the result payload or rejects
  // with the error string from the worker side.
  function runWorkerOnce(worker: Worker, task: PolledTask): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        if (e.data && typeof e.data === "object") {
          if ("ok" in e.data) {
            if (e.data.ok) resolve(e.data.result);
            else reject(new Error(e.data.error || "worker reported failure"));
            cleanup();
          }
          // progress messages (if any) keep streaming until the final
          // {ok: ..} arrives. 052 metadata tasks never emit progress; 053 will.
        }
      };
      const onError = (e: ErrorEvent) => {
        // 078 — ErrorEvent.message is often empty in Chromium for module-type
        // workers (cross-origin security policy redacts it). Fall back to the
        // inner Error.message, then to the event type, then a hard-coded
        // string so executeOne's downstream formatter never sees "".
        const msg = e.message
          || (e.error instanceof Error ? e.error.message : "")
          || `worker fired ${e.type || "error"} event`;
        reject(new Error(msg));
        cleanup();
      };
      function cleanup() {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      }
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(task);
    });
  }

  // ---------------------------------------------------------------------------
  // visibility wiring
  // ---------------------------------------------------------------------------
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stop();
      else if (enabled.value && eligible.value) start();
    });
  }

  // Sync the poll cadence from features. The settings page calls this after a
  // save so the new interval takes effect immediately without reload.
  async function hydrateConfig(): Promise<void> {
    try {
      const text = await edgesonicFetch("features/list");
      const data = JSON.parse(text);
      if (!data.ok) return;
      const fs: Array<{ key: string; value: string }> = data.featureStrings || [];
      const seconds = parseInt(fs.find((f) => f.key === "worker_poll_interval_seconds")?.value || "300", 10);
      const ms = Number.isFinite(seconds) && seconds >= 30 ? seconds * 1000 : DEFAULT_POLL_MS;
      if (ms !== pollIntervalMs.value) {
        pollIntervalMs.value = ms;
        // Rotate the interval if it's running so the new cadence applies.
        if (intervalId !== null) { stop(); start(); }
      }
    } catch { /* fail-quiet — keep DEFAULT_POLL_MS */ }
  }

  function reset(): void {
    stop();
    stats.value = { completed: 0, failed: 0, currentTaskType: "" };
    lastError.value = null;
    // 056 — also wipe the HUD-facing surface so a logout doesn't leave
    // stale chips for the next user.
    recent.value = [];
    completedSamples.value = [];
  }

  return {
    enabled,
    caps,
    eligible,
    stats,
    lastError,
    lastPollAt,
    pollIntervalMs,
    // 056 — HUD-facing
    recent,
    speedPerMin,
    isWorking,
    start,
    stop,
    setEnabled,
    pollNow,
    hydrateConfig,
    reset,
  };
});
