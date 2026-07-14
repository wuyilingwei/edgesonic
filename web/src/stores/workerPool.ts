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

// ---------------------------------------------------------------------------
// The store is registered on app start (main.ts). Whenever the page is
// visible AND `enabled` is true AND the user has level ≥ 2, we hit
// /edgesonic/work/poll every `pollIntervalMs` (default 5 min) and drain the
// returned tasks via the Web Worker entry in workers/taskExecutor.ts.
//
// Lifecycle:
//  - login → start() → set interval + immediately drain once
//  - visibility hidden → stop() (browsers throttle setInterval anyway, but
//                                explicit stop saves us a noisy poll on
//                                reactivate when the cached interval is stale)
//  - visibility visible → start() if enabled
//  - logout → stop() + reset stats
//
// Stats are live for the Settings UI. The current task type is shown so an
// admin can confirm the pool is actually doing work.

import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useAuth } from "../api";
import { usePlayerStore } from "./player";

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
// concurrency is now a *local-only* setting (per-browser). Saving
// writes localStorage instead of POSTing to /features/updateString. When
// unset, hydrateConfig falls back to the server-side feature_strings default
// (the seeded `worker_max_concurrent` row preserves a sane global default).
const STORAGE_KEY_CONCURRENCY = "edgesonic:worker_max_concurrent";
const DEFAULT_POLL_MS = 5 * 60 * 1000;
// 093g — Adaptive poll cadence. When the queue has work, poll aggressively
// (every 30s) so a 1000-task scan backlog drains in minutes instead of
// hours. When the queue is empty, fall back to the configured interval
// (default 5 min) so idle browsers don't hammer D1.
const FAST_POLL_MS = 30 * 1000;

// Memory monitoring configuration
const MEMORY_SAMPLE_INTERVAL_MS = 30 * 1000; // 30 秒采样一次
const MAX_MEMORY_SAMPLES = 120; // 1 小时数据（30s 采样）
const MEMORY_CLEANUP_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50MB

interface MemorySample {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
}

// taskExecutor.ts AND the server-side clamp in /work/submit. Three layers of
// 500-byte truncation is intentional: each layer protects its own surface
// from runaway error strings (memory churn on the worker, postMessage cost
// on the main thread, D1 column blowup on the server).
const ERR_LIMIT = 500;

/**
 *
 * Prefix carries enough context to grep work_queue.error_message rows:
 *  "[metadata:abcd1234] HTTP 503 from r2-stream"
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

/**
 * 113 — AIMD-style adaptive concurrency step. Given how the last batch went,
 * returns the concurrency to use for the NEXT poll cycle:
 *   - any failure in the batch → halve it (min 1) — back off hard the moment
 *     the device/network shows strain.
 *   - all succeeded → +1, capped at `ceiling` — ramp up one step at a time
 *     while everything is going well.
 *   - empty batch (no tasks polled) → unchanged, nothing to learn from.
 * Exported so the unit test can exercise the ramp/backoff curve without
 * spinning up the whole Pinia store + mocked fetch/Worker plumbing.
 */
export function nextConcurrency(
  current: number,
  ceiling: number,
  batch: { total: number; failed: number },
): number {
  if (batch.total === 0) return current;
  if (batch.failed > 0) return Math.max(1, Math.floor(current / 2));
  return Math.min(ceiling, current + 1);
}

export const useWorkerPool = defineStore("workerPool", () => {
  const { level, edgesonicFetch, edgesonicPost, restUrl } = useAuth();

  // --- reactive state ---
  // Opt-in (default off): only enabled once the user explicitly turns it on;
  // the choice persists in localStorage so it survives reload. The Settings UI
  // is the only place that flips this; the store reads it on start.
  const enabled = ref(localStorage.getItem(STORAGE_KEY) === "true");
  // Run-time poll cadence; hydrated from features/list once on start so the
  // server-side default propagates. We never poll faster than 30s even if
  // mis-configured — feature_strings.worker_poll_interval_seconds is clamped
  // 30..3600 by the worker validator.
  const pollIntervalMs = ref(DEFAULT_POLL_MS);
  // the /work/poll `limit=` (so the server hands us exactly N tasks) and the
  // Promise.all fan-out below. Initial value comes from localStorage (set by
  // Tools.vue's "保存" button); if unset, hydrateConfig seeds it from the
  // server-side feature_strings.worker_max_concurrent so brand-new browsers
  // still inherit the admin-configured global default.
  // Clamped 1..8 on both sides (server validator + client hydrate guard).
  const maxConcurrent = ref(parseInt(localStorage.getItem(STORAGE_KEY_CONCURRENCY) || "0", 10) || 3);
  // Local-only setter — Tools.vue calls this instead of updateString. Writes
  // localStorage so the value survives reloads and stays scoped to *this*
  // browser (the concurrency knob only affects this browser's poll limit).
  function setMaxConcurrent(n: number): void {
    const mc = Math.max(1, Math.min(8, Math.floor(Number(n) || 0)));
    maxConcurrent.value = mc;
    localStorage.setItem(STORAGE_KEY_CONCURRENCY, String(mc));
  }
  // 113 — maxConcurrent above is only a CEILING; currentConcurrency is the
  // real, adaptive value pollAndDrain actually uses per cycle. It starts at
  // 1 and ramps up by +1 each cycle where every task in the batch succeeded
  // (device/network has headroom), or halves back down (min 1) the moment a
  // cycle has any failure (device/network is straining). This auto-tunes to
  // "however fast this particular browser can actually go" instead of
  // blindly claiming the (locally-set) ceiling regardless of real hardware/
  // bandwidth.
  const currentConcurrency = ref(1);
  const stats = ref({ completed: 0, failed: 0, currentTaskType: "", currentFileName: "" });
  const lastError = ref<string | null>(null);
  const lastPollAt = ref<number>(0);
  // 089 S, refined true while the pool is paused because the player is
  // actively streaming. watch() on player.playing flips this and calls stop()
  // / start(); the in-poll `effectiveConcurrent = 1` fallback stays as the belt
  // for tasks already in-flight when playback starts.
  const isPlaybackThrottled = ref(false);

  // Memory monitoring: 30 秒采样一次内存使用情况
  const memoryHistory = ref<MemorySample[]>([]);
  let memoryMonitorInterval: number | null = null;

  function startMemoryMonitor(): void {
    if (memoryMonitorInterval !== null) return;
    memoryMonitorInterval = window.setInterval(() => {
      sampleMemory();
    }, MEMORY_SAMPLE_INTERVAL_MS);
  }

  function stopMemoryMonitor(): void {
    if (memoryMonitorInterval !== null) {
      clearInterval(memoryMonitorInterval);
      memoryMonitorInterval = null;
    }
  }

  function sampleMemory(): void {
    if (performance.memory) {
      const sample: MemorySample = {
        timestamp: Date.now(),
        heapUsed: performance.memory.usedJSHeapSize,
        heapTotal: performance.memory.totalJSHeapSize,
      };
      memoryHistory.value.push(sample);
      if (memoryHistory.value.length > MAX_MEMORY_SAMPLES) {
        memoryHistory.value.shift();
      }
      // 自动清理：超过 50MB 时触发
      if (performance.memory.usedJSHeapSize > MEMORY_CLEANUP_THRESHOLD_BYTES) {
        // 标记需要清理，但不强制执行垃圾回收（JS 无法直接触发）
        // 只记录此状态供监控使用
      }
    }
  }

  // Response time tracking for adaptive playback throttling
  const responseTimes = ref<number[]>([]);
  const MAX_RESPONSE_TIME_SAMPLES = 20;

  function recordResponseTime(time: number): void {
    responseTimes.value.push(time);
    if (responseTimes.value.length > MAX_RESPONSE_TIME_SAMPLES) {
      responseTimes.value.shift();
    }
  }

  function getAverageResponseTime(): number {
    if (responseTimes.value.length === 0) return 0;
    const sum = responseTimes.value.reduce((a, b) => a + b, 0);
    return sum / responseTimes.value.length;
  }

  function getPlaybackThrottle(avgResponseTime: number): number {
    // Based on average response time, return playback throttle factor
    // Lower values mean more aggressive throttling (preserving bandwidth for playback)
    if (avgResponseTime < 200) return 1.5; // 快速响应
    if (avgResponseTime < 500) return 1.0; // 正常
    if (avgResponseTime < 1000) return 0.5; // 缓慢
    return 0.25; // 非常缓慢
  }

  // - `recent` is a small FIFO ring (≤ 5) of just-finished tasks so the UI
  //  can show task chips without re-querying the server.
  // - `completedSamples` powers the speed estimator: we push one entry per
  //  completed/failed task and compute completions/min over the last 5min.
  //  Memory cap is the SAMPLE_LIMIT below (older entries get dropped).
  // - `isWorking` is true any time the pool is busy (either running a task
  //  or mid-poll) so the HUD can hide itself when truly idle.
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
  let draining = false;
  // `isWorking` updates when poll-and-drain starts/stops without a task.
  const isDraining = ref(false);

  // a task is currently executing (currentTaskType is non-empty) or we're
  // mid-poll. Falls back to false when fully idle so Files.vue can collapse
  // the work-queue block.
  const isWorking = computed(() =>
    !!stats.value.currentTaskType || isDraining.value,
  );

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
  // 093g — Self-scheduling timeout replaces fixed setInterval. After each
  // poll, next delay is chosen based on whether the queue had work:
  //  - got tasks → FAST_POLL_MS (30s) for aggressive drain
  //   - empty   → pollIntervalMs (configured, default 5min) for idle
  // This lets a 1000-task scan backlog drain in ~10 min instead of ~16 h,
  // without changing the idle behaviour that protects D1 from over-polling.
  let timeoutId: number | null = null;
  let hadTasksLastPoll = false;
  // Tools.vue shows a live "auto-start in mm:ss" countdown next to the
  // manual poll button. Reactive so the UI can derive a ticking display from
  // it without reaching into the module-local `timeoutId`/`poolStartedAt`.
  // 0 means "nothing scheduled" (pool disabled/ineligible/stopped).
  const nextPollAt = ref<number>(0);

  function scheduleNext(): void {
    if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
    if (!enabled.value || !eligible.value) { nextPollAt.value = 0; return; }
    // so a briefly-opened tab doesn't grab tasks. After the grace period,
    // aggressive 30s polling kicks in if the queue has work.
    const sinceStart = Date.now() - poolStartedAt;
    const inGracePeriod = sinceStart < START_DELAY_MS;
    const delay = inGracePeriod
      ? pollIntervalMs.value
      : (hadTasksLastPoll ? FAST_POLL_MS : pollIntervalMs.value);
    nextPollAt.value = Date.now() + delay;
    timeoutId = window.setTimeout(async () => {
      await pollAndDrain();
      scheduleNext();
    }, delay);
  }

  // first automatic poll by 5 minutes so a briefly-opened tab doesn't grab
  // work queue tasks. Manual pollNow() bypasses this delay.
  const START_DELAY_MS = 5 * 60 * 1000;
  let poolStartedAt = 0;

  function start(): void {
    if (timeoutId !== null) return;
    if (!enabled.value || !eligible.value) return;
    // 5 minutes. User can click "force poll" in the UI to start instantly.
    poolStartedAt = Date.now();
    hadTasksLastPoll = false;
    startMemoryMonitor();
    scheduleNext();
  }

  function stop(): void {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    stopMemoryMonitor();
    nextPollAt.value = 0;
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
    // 085 fix: 移除 document.hidden 检查 — Web Worker 不影响其他 tab，
    // 用户切到别的 tab 时 EdgeSonic 应继续后台消化 work_queue。Chrome
    // visibility hidden 的 setInterval 会被节流但仍能跑，不影响功能。
    draining = true;
    isDraining.value = true;
    lastError.value = null;
    lastPollAt.value = Date.now();
    // 采样内存使用情况
    sampleMemory();
    try {
      // 113 — the ceiling may have been lowered by an admin since the last
      // ramp-up; clamp before using it as the adaptive base.
      if (currentConcurrency.value > maxConcurrent.value) {
        currentConcurrency.value = maxConcurrent.value;
      }
      // 089 S — Adaptive concurrency: when music is actively playing, throttle
      // metadata workers down to 1 so they don't compete with the player's own
      // /rest/stream Range requests for R2 bandwidth. Each metadata worker
      // fetches up to 512 KB from /rest/stream; at full concurrency that means
      // several concurrent sub-requests competing with the player's stream →
      // degraded throughput. Reducing to 1 during playback lets the player
      // dominate the available bandwidth while background work still trickles
      // through. Falls back to full concurrency when the store isn't mounted.
      let effectiveConcurrent = currentConcurrency.value;
      isPlaybackThrottled.value = false;
      try {
        const player = usePlayerStore();
        if (player.playing) {
          effectiveConcurrent = 1;
          isPlaybackThrottled.value = true;
        }
      } catch { /* player store not available yet — keep adaptive concurrency */ }

      // many tasks as we can run in parallel, then Promise.all fans them out
      // through executeOne. Each executeOne owns its own Web Worker so they
      // never share state — fetch + parseBuffer + submit run concurrently.
      const text = await edgesonicFetch("work/poll", {
        caps: caps.value.join(","),
        limit: String(effectiveConcurrent),
      });
      const data: PollResponse = JSON.parse(text);
      if (!data.ok) throw new Error(data.error || "poll rejected");
      // 093g — track whether the queue had work so scheduleNext can pick
      // the fast or idle cadence.
      const tasks = data.tasks || [];
      hadTasksLastPoll = tasks.length > 0;
      // 088 — concurrent drain. `Promise.all` doesn't short-circuit on first
      // rejection here because executeOne catches its own errors (recording
      // failed stats + pushRecent) and resolves anyway, so a single bad task
      // doesn't stop its siblings.
      const beforeFailed = stats.value.failed;
      await Promise.all(tasks.map((task) => executeOne(task)));

      // 113 — adjust the adaptive concurrency for the NEXT cycle based on how
      // this batch went. Skipped during playback throttling — that's a
      // deliberate override, not a signal about the device's real capacity.
      if (!isPlaybackThrottled.value) {
        currentConcurrency.value = nextConcurrency(currentConcurrency.value, maxConcurrent.value, {
          total: tasks.length,
          failed: stats.value.failed - beforeFailed,
        });
      }
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e);
    } finally {
      stats.value.currentTaskType = "";
      stats.value.currentFileName = "";
      draining = false;
      isDraining.value = false;
    }
  }

  async function executeOne(task: PolledTask): Promise<void> {
    stats.value.currentTaskType = task.taskType;
    stats.value.currentFileName = fileNameFrom(task);
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
      pushRecent({
        id: task.id,
        taskType: task.taskType,
        fileName: fileNameFrom(task),
        status: "ok",
        finishedAt: Date.now(),
      });
      recordSample();
    } catch (e) {
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
  // 085 fix: 移除 visibility hidden 时 stop() — Web Worker 不阻塞其他 tab
  // 用户切到别的 tab 时 EdgeSonic 应继续后台消化 work_queue。
  // 仍然在 visible 变化时尝试 start() (如果之前因为别的原因停了的话)。
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && enabled.value && eligible.value) start();
    });
  }

  // Playback auto-pause. Each metadata worker pulls up to 512KB from
  // /rest/stream; even with concurrency=1 those sub-requests compete with
  // the active player's own stream range requests for the R2 egress budget
  // and can cause audible stalls. Instead of just throttling concurrency,
  // we now fully stop scheduling new polls while a song is playing and
  // resume when playback pauses/stops (so long as the pool is still opted-in).
  // The pollAndDrain `effectiveConcurrent = 1` fallback below stays as a belt
  // for tasks that were already in-flight when playback started.
  try {
    const player = usePlayerStore();
    watch(() => player.playing, (playing) => {
      if (playing) {
        isPlaybackThrottled.value = true;
        stop();
      } else {
        isPlaybackThrottled.value = false;
        if (enabled.value && eligible.value) start();
      }
    });
  } catch { /* player store not registered yet — keep default schedule */ }

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
        // Reschedule so the new cadence applies on the next tick.
        if (timeoutId !== null) { stop(); start(); }
      }
      // belt-and-braces guard; the server validator already rejects anything
      // outside the same range. Default 3 matches the migration seed. 122: a
      // localStorage value (i.e. the user has explicitly saved a concurrency
      // for this browser) wins over the server default — concurrency is now a
      // per-browser local setting, so we never let hydrateConfig clobber it.
      const localMc = parseInt(localStorage.getItem(STORAGE_KEY_CONCURRENCY) || "0", 10);
      let mc: number | undefined;
      if (Number.isFinite(localMc) && localMc >= 1 && localMc <= 8) {
        mc = localMc;
      } else {
        const serverMc = parseInt(fs.find((f) => f.key === "worker_max_concurrent")?.value || "3", 10);
        if (Number.isFinite(serverMc) && serverMc >= 1 && serverMc <= 8) mc = serverMc;
      }
      if (mc !== undefined) {
        maxConcurrent.value = mc;
        // 113 — the ceiling may have just shrunk below where the adaptive
        // value had ramped to; clamp immediately rather than waiting for the
        // next drain cycle to notice.
        if (currentConcurrency.value > mc) currentConcurrency.value = mc;
      }
    } catch { /* fail-quiet — keep DEFAULT_POLL_MS */ }
  }

  function reset(): void {
    stop();
    stats.value = { completed: 0, failed: 0, currentTaskType: "", currentFileName: "" };
    lastError.value = null;
    // stale chips for the next user.
    recent.value = [];
    completedSamples.value = [];
    memoryHistory.value = [];
    // 113 — start the next session's adaptive ramp from scratch rather than
    // carrying over a value tuned for whatever device/network the previous
    // session had.
    currentConcurrency.value = 1;
  }

  return {
    enabled,
    caps,
    eligible,
    stats,
    lastError,
    lastPollAt,
    pollIntervalMs,
    // 088 — concurrency ceiling (live), surfaced so Tools.vue can read+display
    // alongside pollIntervalMs without a separate fetch.
    maxConcurrent,
    // local-only setter (writes localStorage, no server POST).
    setMaxConcurrent,
    // 113 — the real, adaptive concurrency pollAndDrain is currently using.
    currentConcurrency,
    // 089 S — playback-throttle indicator for the Settings UI.
    isPlaybackThrottled,
    recent,
    speedPerMin,
    isWorking,
    // Memory monitoring: 内存使用趋势 (30秒采样，最多120个样本)
    memoryHistory,
    // Response time tracking for adaptive throttling
    recordResponseTime,
    getAverageResponseTime,
    getPlaybackThrottle,
    // Tools.vue "auto-start in mm:ss" countdown next to the manual
    // poll button. 0 = nothing scheduled.
    nextPollAt,
    start,
    stop,
    setEnabled,
    pollNow,
    hydrateConfig,
    reset,
  };
});
