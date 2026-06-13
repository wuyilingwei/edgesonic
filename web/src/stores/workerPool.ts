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

  // capabilities — what this browser can actually execute. The Worker poll
  // endpoint takes a `caps=` parameter; we filter on the server using these.
  const caps = computed<string[]>(() => {
    const c: string[] = ["music-metadata", "scrape"];
    // ffmpeg.wasm needs SharedArrayBuffer (cross-origin isolation). EdgeSonic
    // doesn't set COOP/COEP today (would break 024's coverArt embedding), so
    // the check usually returns false. 053 owns the COOP/COEP migration.
    if (typeof globalThis !== "undefined" && "SharedArrayBuffer" in globalThis) {
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // submit error so the row goes back to queued (or to failed if exhausted).
      // We deliberately ignore the submit's own response — if the network is
      // also down we'll let the reclaim sweep catch the row.
      try { await edgesonicPost("work/submit", { id: task.id, error: msg }); } catch { /* ignore */ }
      stats.value.failed++;
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
        reject(new Error(e.message || "worker errored"));
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
  }

  return {
    enabled,
    caps,
    eligible,
    stats,
    lastError,
    lastPollAt,
    pollIntervalMs,
    start,
    stop,
    setEnabled,
    pollNow,
    hydrateConfig,
    reset,
  };
});
