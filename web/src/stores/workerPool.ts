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
// visible AND `enabled` is true AND the user holds participate_work, we hit
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
// Continuous drain. While the queue has work, the next cycle starts
// back-to-back with no artificial gap (previously a fixed 30s fast-poll
// wait), so a large scan backlog drains as fast as this browser can go.
// When the queue is empty, fall back to the configured interval (default
// 5 min) so idle browsers don't hammer D1.

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
  const { hasPerm, edgesonicFetch, edgesonicPost, restUrl } = useAuth();

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
  // reference-counted pause. Playback, generic page activity, and
  // known bandwidth/CPU-heavy manual operations (upload, clone, cross-copy,
  // batch tag write...) each add their own reason string while active and
  // remove it when done; the pool only resumes once every reason has
  // cleared, so overlapping interruptions don't cause one to prematurely
  // resume the other's pause. See pauseForActivity/resumeAfterActivity.
  const pauseReasons = new Set<string>();
  const isActivityPaused = ref(false);
  // AbortController for whatever /work/poll fetch or Worker task is
  // currently in flight, so pauseForActivity can cancel it immediately
  // instead of waiting for the current drain cycle to finish naturally.
  let currentAbort: AbortController | null = null;

  // Memory monitoring: 30 秒采样一次内存使用情况
  const memoryHistory = ref<MemorySample[]>([]);
  let memoryMonitorInterval: number | null = null;

  type PerformanceMemory = {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
  };

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
    const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
    if (memory) {
      const sample: MemorySample = {
        timestamp: Date.now(),
        heapUsed: memory.usedJSHeapSize,
        heapTotal: memory.totalJSHeapSize,
      };
      memoryHistory.value.push(sample);
      if (memoryHistory.value.length > MAX_MEMORY_SAMPLES) {
        memoryHistory.value.shift();
      }
      // 自动清理：超过 50MB 时触发
      if (memory.usedJSHeapSize > MEMORY_CLEANUP_THRESHOLD_BYTES) {
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

  // Gated by the participate_work permission (level 1 "user" and up have it
  // by default; only guests are denied — see Schema.sql's permission seed).
  // Users without it get the toggle disabled in Tools.vue, but we
  // double-check here in case someone localStorage-hacks the flag — the
  // server permission check on /work/poll is the real, authoritative gate.
  const eligible = computed(() => hasPerm("participate_work"));

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
  // Self-scheduling timeout replaces fixed setInterval. After each
  // poll, next delay is chosen based on whether the queue had work:
  //  - got tasks → 0 (continuous, back-to-back) for aggressive drain
  //  - empty     → IDLE_PROBE_MS (short) so a fresh batch is picked up
  //                soon after the previous one finished, instead of
  //                waiting the full configured idle interval.
  // pollIntervalMs (default 5min) is only used during the post-start /
  // post-resume grace period so a briefly-opened tab doesn't grab tasks.
  let timeoutId: number | null = null;
  let hadTasksLastPoll = false;
  // Tools.vue shows a live "auto-start in mm:ss" countdown next to the
  // manual poll button. Reactive so the UI can derive a ticking display from
  // it without reaching into the module-local `timeoutId`/`poolStartedAt`.
  // 0 means "nothing scheduled" (pool disabled/ineligible/stopped/paused).
  const nextPollAt = ref<number>(0);

  function scheduleNext(): void {
    if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
    if (!enabled.value || !eligible.value) { nextPollAt.value = 0; return; }
    // Still paused (playback/manual activity) — don't self-reschedule.
    // Guards the race where pauseForActivity() stopped the timer while a
    // poll cycle was already running; that cycle's trailing scheduleNext()
    // call (below) would otherwise re-arm the timer while still paused.
    // resumeAfterActivity() calls start() fresh once every reason clears.
    if (pauseReasons.size > 0) { nextPollAt.value = 0; return; }
    // so a briefly-opened tab doesn't grab tasks. After the grace period,
    // continuous polling kicks in if the queue has work.
    const sinceStart = Date.now() - poolStartedAt;
    const inGracePeriod = sinceStart < START_DELAY_MS;
    const delay = inGracePeriod
      ? pollIntervalMs.value
      : (hadTasksLastPoll ? 0 : IDLE_PROBE_MS);
    nextPollAt.value = Date.now() + delay;
    timeoutId = window.setTimeout(async () => {
      await pollAndDrain();
      scheduleNext();
    }, delay);
  }

  // first automatic poll by 5 minutes so a briefly-opened tab doesn't grab
  // work queue tasks. Manual pollNow() bypasses this delay.
  const START_DELAY_MS = 5 * 60 * 1000;
  // Short idle probe used after the grace period when the last poll found
  // no tasks. Keeps a drained batch from waiting 5 minutes before the next
  // check; the server-side poll is cheap (single indexed SELECT).
  const IDLE_PROBE_MS = 10_000;
  let poolStartedAt = 0;

  function start(): void {
    if (timeoutId !== null) return;
    if (!enabled.value || !eligible.value) return;
    if (pauseReasons.size > 0) return;
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

  // abort whatever /work/poll fetch or task Worker is currently in
  // flight. Aborted tasks are neither reported as success nor failure (see
  // executeOne); they simply stay claimed until the server-side heartbeat/
  // reclaim sweep (workReclaim.ts) puts them back in the queue.
  function abortInFlight(): void {
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
  }

  // Add `reason` to the pause set and stop immediately, cancelling any
  // in-flight request/task rather than letting it finish. Safe to call
  // repeatedly / from multiple independent triggers (playback, generic page
  // activity, a specific heavy operation) — the pool only actually resumes
  // once every reason has been removed via resumeAfterActivity.
  function pauseForActivity(reason: string): void {
    pauseReasons.add(reason);
    isActivityPaused.value = true;
    abortInFlight();
    stop();
  }

  // Remove `reason` from the pause set; once no reason remains, re-enter the
  // normal 5-minute idle wait via a fresh start() (which resets the
  // post-start grace period so we don't immediately hammer the queue).
  function resumeAfterActivity(reason: string): void {
    pauseReasons.delete(reason);
    if (pauseReasons.size > 0) return;
    isActivityPaused.value = false;
    if (enabled.value && eligible.value) start();
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
    // owns this cycle's in-flight fetch/task so pauseForActivity can
    // cancel it immediately from outside (playback start, manual activity).
    const abort = new AbortController();
    currentAbort = abort;
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
      }, abort.signal);
      const data: PollResponse = JSON.parse(text);
      if (!data.ok) throw new Error(data.error || "poll rejected");
      // track whether the queue had work so scheduleNext can pick
      // the continuous or idle cadence.
      const tasks = data.tasks || [];
      hadTasksLastPoll = tasks.length > 0;
      // 088 — concurrent drain. `Promise.all` doesn't short-circuit on first
      // rejection here because executeOne catches its own errors (recording
      // failed stats + pushRecent) and resolves anyway, so a single bad task
      // doesn't stop its siblings.
      const beforeFailed = stats.value.failed;
      await Promise.all(tasks.map((task) => executeOne(task, abort.signal)));

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
      // a pauseForActivity() abort surfaces here as a DOMException;
      // that's an intentional interruption, not a real failure, so don't
      // clutter lastError (the Settings/Tools UI treats it as a fault).
      const aborted = abort.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      if (!aborted) lastError.value = e instanceof Error ? e.message : String(e);
    } finally {
      stats.value.currentTaskType = "";
      stats.value.currentFileName = "";
      draining = false;
      isDraining.value = false;
      if (currentAbort === abort) currentAbort = null;
    }
  }

  async function executeOne(task: PolledTask, signal: AbortSignal): Promise<void> {
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

      const result = await runWorkerOnce(worker, augmented, signal);
      // interrupted after the worker finished but before we could
      // submit: abandon silently rather than reporting success/failure for
      // work the pause reason (playback/manual activity) already cut short.
      if (signal.aborted) return;
      // Submit success path.
      await edgesonicPost("work/submit", { id: task.id, result }, signal);
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
      // abandoned mid-flight by pauseForActivity(): don't report this
      // as a task failure (that would burn one of its maxAttempts for
      // something that never really ran to completion). The claimed row
      // recovers on its own via the server-side heartbeat/reclaim sweep.
      if (signal.aborted) return;
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
  // with the error string from the worker side. Also rejects immediately if
  // `signal` fires mid-flight, so executeOne's finally can terminate the
  // Worker right away instead of waiting for it to finish on its own.
  function runWorkerOnce(worker: Worker, task: PolledTask, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
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
      const onAbort = () => {
        reject(new DOMException("aborted", "AbortError"));
        cleanup();
      };
      function cleanup() {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      }
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      signal.addEventListener("abort", onAbort);
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
  // and can cause audible stalls. The moment playback starts we now abort
  // whatever request/task is already in flight (pauseForActivity)
  // instead of only cancelling the *next* scheduled poll; resume happens
  // once playback stops, so long as the pool is still opted-in. The
  // pollAndDrain `effectiveConcurrent = 1` fallback below stays as a belt
  // for the narrow window between playback starting and the abort landing.
  try {
    const player = usePlayerStore();
    watch(() => player.playing, (playing) => {
      isPlaybackThrottled.value = playing;
      if (playing) pauseForActivity("playback");
      else resumeAfterActivity("playback");
    });
  } catch { /* player store not registered yet — keep default schedule */ }

  // generic manual-activity auto-pause. Any deliberate interaction
  // with the page (click/keypress/touch/scroll) immediately aborts whatever
  // request/task is in flight and holds the pool paused until the page has
  // been quiet for ACTIVITY_QUIET_MS, at which point it re-enters the normal
  // 5-minute idle wait via resumeAfterActivity(). Deliberately excludes bare
  // `mousemove` — a resting mouse being nudged isn't really "operating" the
  // site and would keep the pool paused almost continuously while the tab is
  // simply open.
  const ACTIVITY_REASON = "user-activity";
  const ACTIVITY_QUIET_MS = 3 * 1000;
  let activityQuietTimer: number | null = null;

  function onManualActivity(): void {
    if (!pauseReasons.has(ACTIVITY_REASON)) pauseForActivity(ACTIVITY_REASON);
    if (activityQuietTimer !== null) window.clearTimeout(activityQuietTimer);
    activityQuietTimer = window.setTimeout(() => {
      activityQuietTimer = null;
      resumeAfterActivity(ACTIVITY_REASON);
    }, ACTIVITY_QUIET_MS);
  }

  if (typeof document !== "undefined") {
    const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart", "wheel"] as const;
    for (const evt of ACTIVITY_EVENTS) {
      document.addEventListener(evt, onManualActivity, { passive: true });
    }
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
    // reference-counted pause for known bandwidth/CPU-heavy manual
    // operations (upload, clone/push, cross-copy, batch tag write, tag
    // scan...). Call pauseForActivity(reason) before the operation starts
    // and resumeAfterActivity(reason) in its `finally`, using the same
    // reason string both times. Safe if multiple operations overlap.
    isActivityPaused,
    pauseForActivity,
    resumeAfterActivity,
  };
});
