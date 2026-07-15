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

import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useAuth, parseXmlAttrs } from "../api";
import { getTrackMetadataXml, preloadTrack } from "../lib/trackPrefetch";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverArt?: string;
  duration: number;
  starred?: boolean;
  starredAt?: string;
  createdAt?: string;
  artistId?: string;
  albumId?: string;
}

interface IncrementalFallbackState {
  trackId: string;
  sourceUrl: string;
  chunks: Blob[];
  downloaded: number;
  stepIndex: number;
  contentType: string;
  shouldPlay: boolean;
  phase: "range" | "full";
}

interface FullDownloadState {
  trackId: string;
  controller: AbortController;
}

interface PreloadedTrack {
  el: HTMLAudioElement;
  index: number;
  ready: boolean;
}

/**
 * Player store — owns two <audio> elements (double buffering) and the queue.
 *
 * Stream URLs are freshly signed per call (t = md5(sessionToken + salt)), so a
 * preloaded track can NOT be replayed via browser HTTP cache — the inactive
 * element preloads the next track and is swapped in on next()/ended.
 */
export const usePlayerStore = defineStore("player", () => {
  const queue = ref<Track[]>([]);
  const index = ref(-1);
  const playing = ref(false);
  const currentTime = ref(0);
  const duration = ref(0);
  const volume = ref(parseFloat(
    localStorage.getItem("edgesonic:volume") ||
    localStorage.getItem("edgesonic_volume") ||
    "0.8"
  ));
  // 093d — buffered range tracking for the PlayerBar buffer bar overlay.
  // `bufferedRanges` is an array of [startSec, endSec] tuples representing
  // the byte ranges the browser has fetched so far. Updated on `progress`
  // events from the active <audio> element (fires ~4×/s during download).
  const bufferedRanges = ref<[number, number][]>([]);

  // Single cycling play mode (replaces the old independent repeatMode +
  // shuffle toggles — the UI now exposes exactly one button that cycles
  // sequential -> single -> shuffle -> sequential, matching how most music
  // players present this). "sequential" loops the whole queue at the end
  // (there is no standalone "stop at end" state anymore).
  type PlayMode = "sequential" | "single" | "shuffle";
  const playMode = ref<PlayMode>(
    (localStorage.getItem("edgesonic:playMode") as PlayMode) || "sequential"
  );
  // Internal shuffle order — the actual queue array is never shuffled; instead
  // we maintain a parallel index order for shuffle playback.
  let _shuffleOrder: number[] = [];

  const current = computed<Track | null>(() => queue.value[index.value] || null);
  const hasTrack = computed(() => index.value >= 0 && index.value < queue.value.length);

  // ---- Favorite (Subsonic star/unstar) ----
  // Queue entries (built ad hoc by each view from search3/getAlbum/etc. XML)
  // don't carry a `starred` field, so we look it up fresh per track via
  // getSong rather than threading it through every call site that builds a
  // Track. `current.value?.id !== id` guards against a stale response
  // landing after the user has already skipped to another track.
  const starred = ref(false);
  async function _refreshStarred(id: string) {
    try {
      const { authFetch, username } = useAuth();
      const xml = await getTrackMetadataXml({ id }, { authFetch, scope: username.value });
      if (current.value?.id !== id) return;
      starred.value = !!parseXmlAttrs(xml, "song")[0]?.starred;
    } catch {
      if (current.value?.id === id) starred.value = false;
    }
  }
  watch(current, (tr) => {
    if (!tr) { starred.value = false; return; }
    void _refreshStarred(tr.id);
  }, { immediate: true });

  async function toggleStar() {
    const tr = current.value;
    if (!tr) return;
    const next = !starred.value;
    starred.value = next; // optimistic
    try {
      const { authFetch } = useAuth();
      await authFetch(next ? "star" : "unstar", { id: tr.id });
    } catch {
      if (current.value?.id === tr.id) starred.value = !next; // revert on failure
    }
  }

  let elA: HTMLAudioElement | null = null;
  let elB: HTMLAudioElement | null = null;
  let active: HTMLAudioElement | null = null;
  let preloaded: PreloadedTrack | null = null;
  // Pending seek position to restore after loadedmetadata fires (page-reload resume).
  let _pendingRestoreTime: number | null = null;
  const FALLBACK_RANGE_STEPS = [1_200_000, 2_400_000, 4_800_000, 9_600_000];
  const blobSrcByElement = new WeakMap<HTMLAudioElement, string>();
  const fallbackAttemptByElement = new WeakMap<HTMLAudioElement, string>();
  const fallbackStateByElement = new WeakMap<HTMLAudioElement, IncrementalFallbackState>();
  const fallbackTerminalTrackByElement = new WeakMap<HTMLAudioElement, string>();
  const fullDownloadByElement = new WeakMap<HTMLAudioElement, FullDownloadState>();
  const fullBlobOriginByElement = new WeakMap<HTMLAudioElement, "background" | "fallback">();
  const fullyLoadedByElement = new WeakSet<HTMLAudioElement>();
  const fallbackInFlight = new WeakSet<HTMLAudioElement>();

  function revokeBlobSrc(el: HTMLAudioElement) {
    const blobSrc = blobSrcByElement.get(el);
    if (blobSrc) {
      URL.revokeObjectURL(blobSrc);
      blobSrcByElement.delete(el);
    }
  }

  function abortFullDownload(el: HTMLAudioElement) {
    const state = fullDownloadByElement.get(el);
    if (!state) return;
    state.controller.abort();
    fullDownloadByElement.delete(el);
  }

  function resetFallbackState(el: HTMLAudioElement) {
    abortFullDownload(el);
    revokeBlobSrc(el);
    fallbackAttemptByElement.delete(el);
    fallbackStateByElement.delete(el);
    fallbackInFlight.delete(el);
    fallbackTerminalTrackByElement.delete(el);
    fullBlobOriginByElement.delete(el);
    fullyLoadedByElement.delete(el);
  }

  async function blobHeadHex(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
  }

  async function logFallbackBlob(label: string, resp: Response, blob: Blob) {
    console.info("[Player] fallback fetch", {
      label,
      status: resp.status,
      contentType: resp.headers.get("Content-Type") || blob.type || "",
      contentRange: resp.headers.get("Content-Range") || "",
      contentLength: resp.headers.get("Content-Length") || "",
      blobSize: blob.size,
      headHex: await blobHeadHex(blob),
    });
  }

  async function normalizePlayableBlob(blob: Blob): Promise<Blob> {
    const type = blob.type.toLowerCase();
    if (!type.includes("flac")) return blob;

    const probe = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer());
    if (probe.length >= 4 && probe[0] === 0x66 && probe[1] === 0x4c && probe[2] === 0x61 && probe[3] === 0x43) {
      return blob;
    }

    let flacOffset = -1;
    for (let i = 0; i <= probe.length - 4; i++) {
      if (probe[i] === 0x66 && probe[i + 1] === 0x4c && probe[i + 2] === 0x61 && probe[i + 3] === 0x43) {
        flacOffset = i;
        break;
      }
    }
    if (flacOffset <= 0) return blob;

    console.info("[Player] normalized FLAC blob", {
      removedPrefixBytes: flacOffset,
      originalSize: blob.size,
      normalizedSize: blob.size - flacOffset,
    });
    return blob.slice(flacOffset, blob.size, blob.type || "audio/flac");
  }

  async function fetchFullBlob(trackId: string, signal?: AbortSignal): Promise<Blob> {
    const { streamUrl, downloadUrl } = useAuth();
    let lastError: unknown = null;
    for (const [label, url] of [["download-full", downloadUrl(trackId)], ["stream-full", streamUrl(trackId)]] as const) {
      try {
        const resp = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
        if (!resp.ok) throw new Error(`fallback fetch failed: ${resp.status}`);
        const blob = await resp.blob();
        await logFallbackBlob(label, resp, blob);
        return blob;
      } catch (e) {
        if (signal?.aborted) throw e;
        lastError = e;
      }
    }
    throw lastError ?? new Error("fallback fetch failed");
  }

  function playPreparedBlob(
    el: HTMLAudioElement,
    blob: Blob,
    resumeAt: number,
    shouldPlay: boolean,
    completeOrigin: "background" | "fallback" | null,
  ) {
    revokeBlobSrc(el);
    if (completeOrigin) {
      fullyLoadedByElement.add(el);
      fullBlobOriginByElement.set(el, completeOrigin);
    } else {
      fullyLoadedByElement.delete(el);
      fullBlobOriginByElement.delete(el);
    }
    const blobSrc = URL.createObjectURL(blob);
    blobSrcByElement.set(el, blobSrc);
    el.src = blobSrc;
    el.load();
    if (resumeAt > 0) {
      const onMeta = () => {
        el.currentTime = Math.min(resumeAt, Number.isFinite(el.duration) ? el.duration : resumeAt);
        el.removeEventListener("loadedmetadata", onMeta);
      };
      el.addEventListener("loadedmetadata", onMeta);
    }
    if (shouldPlay) void el.play().catch(() => { playing.value = false; });
  }

  async function playFallbackBlob(
    el: HTMLAudioElement,
    blob: Blob,
    resumeAt: number,
    shouldPlay: boolean,
    completeOrigin: "background" | "fallback" | null = null,
  ) {
    const playableBlob = await normalizePlayableBlob(blob);
    playPreparedBlob(el, playableBlob, resumeAt, shouldPlay, completeOrigin);
  }

  function advanceAfterFallbackFailure(el: HTMLAudioElement, trackId: string, reason: unknown) {
    if (el !== active || current.value?.id !== trackId) return;
    if (fallbackTerminalTrackByElement.get(el) === trackId) return;
    fallbackTerminalTrackByElement.set(el, trackId);
    abortFullDownload(el);
    revokeBlobSrc(el);
    fallbackAttemptByElement.delete(el);
    fallbackStateByElement.delete(el);
    fullBlobOriginByElement.delete(el);
    fullyLoadedByElement.delete(el);
    playing.value = false;
    console.error("[Player] all playback attempts failed, skipping track:", reason);
    next();
  }

  async function fallbackToFullBlob(
    el: HTMLAudioElement,
    state: IncrementalFallbackState,
    resumeAt: number,
    shouldPlay: boolean,
  ) {
    state.phase = "full";
    try {
      const blob = await fetchFullBlob(state.trackId);
      if (el !== active || current.value?.id !== state.trackId) return;
      await playFallbackBlob(el, blob, resumeAt, state.shouldPlay || shouldPlay, "fallback");
      fallbackStateByElement.delete(el);
    } catch (e) {
      console.error("[Player] full-file fallback failed:", e);
      advanceAfterFallbackFailure(el, state.trackId, e);
    }
  }

  async function continueIncrementalFallback(el: HTMLAudioElement, state: IncrementalFallbackState, resumeAt: number, shouldPlay: boolean) {
    if (el !== active || fallbackInFlight.has(el)) return;
    const track = current.value;
    if (!track || track.id !== state.trackId) return;

    fallbackInFlight.add(el);
    try {
      while (state.stepIndex < FALLBACK_RANGE_STEPS.length) {
        const target = FALLBACK_RANGE_STEPS[state.stepIndex++];
        if (target <= state.downloaded) continue;
        const resp = await fetch(state.sourceUrl, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Range: `bytes=${state.downloaded}-${target - 1}` },
        });
        if (!resp.ok) throw new Error(`range fallback fetch failed: ${resp.status}`);

        const chunk = await resp.blob();
        await logFallbackBlob(`stream-range-${state.downloaded}-${target - 1}`, resp, chunk);
        if (resp.status === 206) {
          state.chunks.push(chunk);
          state.downloaded += chunk.size;
          state.contentType = state.contentType || chunk.type || resp.headers.get("Content-Type") || "";
          if (chunk.size < target - (state.downloaded - chunk.size)) state.stepIndex = FALLBACK_RANGE_STEPS.length;
        } else {
          state.chunks = [chunk];
          state.downloaded = chunk.size;
          state.contentType = chunk.type || resp.headers.get("Content-Type") || state.contentType;
          state.stepIndex = FALLBACK_RANGE_STEPS.length;
        }

        if (el !== active || current.value?.id !== state.trackId) return;
        const blob = new Blob(state.chunks, { type: state.contentType || undefined });
        await playFallbackBlob(el, blob, resumeAt, state.shouldPlay || shouldPlay);
        return;
      }
    } catch (e) {
      console.warn("[Player] incremental fallback failed, trying full file:", e);
      state.stepIndex = FALLBACK_RANGE_STEPS.length;
    } finally {
      if (fallbackStateByElement.get(el) === state) fallbackInFlight.delete(el);
    }

    if (el === active && current.value?.id === state.trackId) {
      await fallbackToFullBlob(el, state, resumeAt, state.shouldPlay || shouldPlay);
    }
  }

  function beginIncrementalFallback(el: HTMLAudioElement, trackId: string, resumeAt: number, shouldPlay: boolean) {
    const { streamUrl } = useAuth();
    const state: IncrementalFallbackState = {
      trackId,
      sourceUrl: streamUrl(trackId),
      chunks: [],
      downloaded: 0,
      stepIndex: 0,
      contentType: "",
      shouldPlay,
      phase: "range",
    };
    fallbackStateByElement.set(el, state);
    void continueIncrementalFallback(el, state, resumeAt, shouldPlay);
  }

  function fallbackAfterMediaError(el: HTMLAudioElement, failedSrc: string, shouldPlay: boolean) {
    if (!failedSrc) return;
    const track = current.value;
    if (!track) return;
    const resumeAt = Number.isFinite(el.currentTime) ? el.currentTime : currentTime.value;

    if (failedSrc.startsWith("blob:")) {
      const state = fallbackStateByElement.get(el);
      if (blobSrcByElement.get(el) !== failedSrc) return;
      if (state?.phase === "range") {
        void continueIncrementalFallback(el, state, resumeAt, shouldPlay);
      } else if (state?.phase === "full") {
        advanceAfterFallbackFailure(el, track.id, new Error("full fallback blob is not playable"));
      } else if (fullBlobOriginByElement.get(el) === "background") {
        fullyLoadedByElement.delete(el);
        fullBlobOriginByElement.delete(el);
        beginIncrementalFallback(el, track.id, resumeAt, shouldPlay);
      } else {
        advanceAfterFallbackFailure(el, track.id, new Error("playback blob is not playable"));
      }
      return;
    }

    if (el !== active) return;
    abortFullDownload(el);
    if (fallbackTerminalTrackByElement.get(el) === track.id) return;
    if (fallbackAttemptByElement.get(el) === failedSrc) return;
    fallbackAttemptByElement.set(el, failedSrc);
    beginIncrementalFallback(el, track.id, resumeAt, shouldPlay);
  }

  function startFullDownload(
    el: HTMLAudioElement,
    trackId: string,
    onComplete: (blob: Blob) => Promise<void> | void,
    onFailure: (error: unknown) => void,
  ) {
    abortFullDownload(el);
    const state: FullDownloadState = {
      trackId,
      controller: new AbortController(),
    };
    fullDownloadByElement.set(el, state);
    void fetchFullBlob(trackId, state.controller.signal)
      .then(async (blob) => {
        if (fullDownloadByElement.get(el) !== state) return;
        await onComplete(blob);
        if (fullDownloadByElement.get(el) === state) fullDownloadByElement.delete(el);
      })
      .catch((error: unknown) => {
        if (fullDownloadByElement.get(el) !== state) return;
        fullDownloadByElement.delete(el);
        if (!state.controller.signal.aborted) onFailure(error);
      });
  }

  function syncBuffered(el: HTMLAudioElement) {
    if (el !== active) return;
    const next: [number, number][] = [];
    const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration.value;
    if (fullyLoadedByElement.has(el) && dur > 0) {
      next.push([0, dur]);
    } else {
      try {
        for (let i = 0; i < el.buffered.length; i++) {
          const start = el.buffered.start(i);
          const end = el.buffered.end(i);
          if (end - start > 0.05) next.push([start, end]);
        }
      } catch { /* buffered not ready yet */ }
    }
    // Shallow-compare to avoid ref churn when nothing moved.
    const prev = bufferedRanges.value;
    if (prev.length !== next.length ||
        next.some((r, i) => r[0] !== prev[i][0] || r[1] !== prev[i][1])) {
      bufferedRanges.value = next;
    }
  }

  // Preload the next track once the current one is within this many seconds
  // of ending, or past this fraction played — whichever comes first. The
  // timing gate is ANDed with "current track has finished downloading" so the
  // next full-file fetch cannot compete with the current track's fetch.
  const NEXT_TRACK_PRELOAD_SECONDS = 30;
  const NEXT_TRACK_PRELOAD_FRACTION = 0.75;

  function isFullyBuffered(el: HTMLAudioElement, dur: number): boolean {
    if (fullyLoadedByElement.has(el)) return true;
    try {
      const n = el.buffered.length;
      return n > 0 && el.buffered.end(n - 1) >= dur - 0.5;
    } catch {
      return false;
    }
  }

  function makeAudio(): HTMLAudioElement {
    const el = new Audio();
    // `preload="auto"` is only a browser hint and Chromium may stop around a
    // short ahead-buffer. loadCurrent() also consumes a full response and
    // promotes it to a Blob so the active track really becomes fully local.
    el.preload = "auto";
    el.volume = volume.value;
    el.addEventListener("timeupdate", () => {
      if (el !== active) return;
      currentTime.value = el.currentTime;
      const dur = el.duration;
      if (isFinite(dur) && dur > 0) {
        const remaining = dur - el.currentTime;
        const timingOk = remaining <= NEXT_TRACK_PRELOAD_SECONDS || el.currentTime / dur >= NEXT_TRACK_PRELOAD_FRACTION;
        if (timingOk && isFullyBuffered(el, dur)) preloadNext();
      }
    });
    el.addEventListener("durationchange", () => {
      if (el === active && isFinite(el.duration)) {
        duration.value = el.duration;
        syncBuffered(el);
      }
    });
    el.addEventListener("play", () => {
      console.log("[Player] play event, src =", el.src);
      if (el === active) playing.value = true;
    });
    el.addEventListener("pause", () => {
      console.log("[Player] pause event");
      if (el === active) playing.value = false;
    });
    el.addEventListener("ended", () => {
      console.log("[Player] ended event");
      if (el === active) next();
    });
    el.addEventListener("error", (e) => {
      const failedSrc = el.currentSrc || el.src;
      const shouldPlay = playing.value || !el.paused;
      console.error("[Player] audio error event:", el.error ? {
        code: el.error.code,
        message: el.error.message
      } : e, "src =", el.src);
      if (el === active) {
        playing.value = false;
        const code = el.error?.code;
        if (failedSrc && (code === 2 || code === 3 || code === 4)) {
          fallbackAfterMediaError(el, failedSrc, shouldPlay);
        }
      } else if (preloaded?.el === el) {
        // Do not skip the currently-playing song because a speculative next
        // track failed early. Drop the candidate and retry it normally if the
        // user eventually selects it.
        preloaded.ready = false;
        abortFullDownload(el);
      }
    });
    el.addEventListener("stalled", () => {
      console.warn("[Player] stalled event (buffering stalled)");
    });
    el.addEventListener("waiting", () => {
      console.log("[Player] waiting event (waiting for data)");
    });
    el.addEventListener("loadedmetadata", () => {
      console.log("[Player] loadedmetadata event, duration =", el.duration);
    });
    el.addEventListener("canplay", () => {
      console.log("[Player] canplay event");
    });
    el.addEventListener("progress", () => syncBuffered(el));
    return el;
  }

  function ensureElements() {
    if (!elA) elA = makeAudio();
    if (!elB) elB = makeAudio();
    if (!active) active = elA;
  }

  function inactiveEl(): HTMLAudioElement {
    return active === elA ? elB! : elA!;
  }

  function invalidatePreload() {
    if (preloaded) {
      resetFallbackState(preloaded.el);
      preloaded.el.removeAttribute("src");
      preloaded.el.preload = "auto";
      preloaded.el.load();
      preloaded = null;
    }
  }

  /** Fully prebuffer the next queue entry into the inactive element. */
  function preloadNext() {
    ensureElements();
    const ni = index.value + 1;
    if (ni >= queue.value.length) { invalidatePreload(); return; }
    if (preloaded?.index === ni) return;
    invalidatePreload();
    const nextTrack = queue.value[ni];
    const { authFetch, coverArtUrl, username } = useAuth();
    preloadTrack(nextTrack, { authFetch, coverArtUrl, scope: username.value });
    const el = inactiveEl();
    resetFallbackState(el);
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.preload = "auto";
    const candidate: PreloadedTrack = { el, index: ni, ready: false };
    preloaded = candidate;
    // A native audio element may stop an auto preload after a small buffer.
    // Consume the complete response ourselves, then hand the ready Blob to
    // the inactive element for an instant swap.
    startFullDownload(
      el,
      nextTrack.id,
      async (blob) => {
        const playableBlob = await normalizePlayableBlob(blob);
        if (preloaded !== candidate || el === active) return;
        playPreparedBlob(el, playableBlob, 0, false, "background");
        candidate.ready = true;
      },
      (error) => {
        if (preloaded === candidate) {
          console.warn("[Player] next-track full preload failed:", error);
        }
      },
    );
  }

  function loadCurrent(autoplay = true) {
    const track = current.value;
    if (!track) return;
    ensureElements();
    // If restoring a saved position, show it immediately; otherwise reset to 0.
    currentTime.value = _pendingRestoreTime ?? 0;
    duration.value = track.duration || 0;
    bufferedRanges.value = [];

    if (preloaded && preloaded.index === index.value && preloaded.ready) {
      // Swap in the prebuffered element — instant start
      const next = preloaded.el;
      preloaded = null;
      active!.pause();
      resetFallbackState(active!);
      active!.removeAttribute("src");
      active!.load();
      active = next;
      syncBuffered(active);
    } else {
      invalidatePreload();
      const { streamUrl } = useAuth();
      active!.pause();
      resetFallbackState(active!);
      const targetEl = active!;
      const sourceUrl = streamUrl(track.id);
      targetEl.src = sourceUrl;
      targetEl.load();
      startFullDownload(
        targetEl,
        track.id,
        async (blob) => {
          if (active !== targetEl || current.value?.id !== track.id) return;
          const playableBlob = await normalizePlayableBlob(blob);
          if (active !== targetEl || current.value?.id !== track.id) return;
          const resumeAt = Number.isFinite(targetEl.currentTime) ? targetEl.currentTime : currentTime.value;
          const shouldContinue = !targetEl.paused && !targetEl.ended;
          playPreparedBlob(targetEl, playableBlob, resumeAt, shouldContinue, "background");
          syncBuffered(targetEl);
        },
        (error) => {
          console.warn("[Player] complete current-track preload failed; native stream remains active:", error);
        },
      );
    }
    active!.volume = volume.value;

    // One-shot seek to restored position once audio metadata is available.
    if (_pendingRestoreTime !== null) {
      const t = _pendingRestoreTime;
      _pendingRestoreTime = null;
      const onMeta = () => {
        if (active) { active.currentTime = t; currentTime.value = t; }
        active?.removeEventListener("loadedmetadata", onMeta);
      };
      active!.addEventListener("loadedmetadata", onMeta);
    }

    if (autoplay) void active!.play().catch(() => { playing.value = false; });
  }

  /** Replace queue and start playing at startIndex. */
  function setQueue(tracks: Track[], startIndex = 0) {
    _pendingRestoreTime = null; // cancel any page-reload restore when user starts a new queue
    invalidatePreload();
    queue.value = tracks;
    index.value = tracks.length ? Math.min(Math.max(startIndex, 0), tracks.length - 1) : -1;
    loadCurrent();
  }

  function playAt(i: number) {
    if (i < 0 || i >= queue.value.length) return;
    _pendingRestoreTime = null; // cancel restore when user explicitly navigates
    index.value = i;
    loadCurrent();
  }

  function toggle() {
    if (!hasTrack.value) return;
    ensureElements();
    // Audio not loaded yet (e.g. page-reload with restored queue) — load and play.
    // _pendingRestoreTime (if set) will seek to the saved position via loadedmetadata.
    if (!active!.currentSrc) {
      loadCurrent(true);
      return;
    }
    if (active!.paused) void active!.play().catch(() => { playing.value = false; });
    else active!.pause();
  }

  function _regenShuffleOrder() {
    const indices = queue.value.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    _shuffleOrder = indices;
  }

  function _shuffleNextIndex(currentIdx: number): number {
    if (_shuffleOrder.length === 0 || !_shuffleOrder.includes(currentIdx)) {
      _regenShuffleOrder();
      // Move current to front so it doesn't replay immediately.
      const pos = _shuffleOrder.indexOf(currentIdx);
      if (pos > 0) { _shuffleOrder.splice(pos, 1); _shuffleOrder.unshift(currentIdx); }
    }
    const pos = _shuffleOrder.indexOf(currentIdx);
    if (pos < 0) return currentIdx;
    if (pos + 1 < _shuffleOrder.length) return _shuffleOrder[pos + 1];
    return -1; // end of shuffle order — caller regenerates and wraps
  }

  function next() {
    if (playMode.value === "single") {
      // Repeat current track
      if (active) { active.currentTime = 0; void active.play().catch(() => {}); }
      return;
    }
    if (playMode.value === "shuffle") {
      const ni = _shuffleNextIndex(index.value);
      if (ni >= 0) playAt(ni);
      else if (queue.value.length > 0) {
        _regenShuffleOrder();
        playAt(_shuffleOrder[0]);
      } else playing.value = false;
      return;
    }
    if (index.value < queue.value.length - 1) playAt(index.value + 1);
    else if (queue.value.length > 0) playAt(0);
    else playing.value = false;
  }

  function prev() {
    if (!active) return;
    // Restart current track if more than 3s in, like most players.
    if (active.currentTime > 3) { active.currentTime = 0; return; }
    if (playMode.value === "shuffle") {
      const pos = _shuffleOrder.indexOf(index.value);
      if (pos > 0) { playAt(_shuffleOrder[pos - 1]); return; }
      active.currentTime = 0; return;
    }
    if (index.value > 0) playAt(index.value - 1);
    else active.currentTime = 0;
  }

  function seek(seconds: number) {
    if (!hasTrack.value || !active) return;
    active.currentTime = Math.min(Math.max(seconds, 0), duration.value || 0);
    currentTime.value = active.currentTime;
  }

  function setVolume(v: number) {
    volume.value = Math.min(Math.max(v, 0), 1);
    if (elA) elA.volume = volume.value;
    if (elB) elB.volume = volume.value;
    localStorage.setItem("edgesonic:volume", String(volume.value));
  }

  /** Cycle sequential -> single -> shuffle -> sequential. */
  function cyclePlayMode() {
    playMode.value =
      playMode.value === "sequential" ? "single" :
      playMode.value === "single" ? "shuffle" : "sequential";
    localStorage.setItem("edgesonic:playMode", playMode.value);
    if (playMode.value === "shuffle" && queue.value.length > 0) _regenShuffleOrder();
    else _shuffleOrder = [];
  }

  /** Stop playback and clear queue (e.g. on logout). */
  function clear() {
    _pendingRestoreTime = null;
    invalidatePreload();
    for (const el of [elA, elB]) {
      if (el) { el.pause(); resetFallbackState(el); el.removeAttribute("src"); el.load(); }
    }
    queue.value = [];
    index.value = -1;
    playing.value = false;
    currentTime.value = 0;
    duration.value = 0;
    bufferedRanges.value = [];
    // Clear persisted player state on logout so the next session starts fresh.
    localStorage.removeItem("edgesonic:queue");
    localStorage.removeItem("edgesonic:currentIndex");
    localStorage.removeItem("edgesonic:currentTime");
    localStorage.removeItem("edgesonic:playMode");
  }

  // ---- localStorage persistence ----

  /** Serialize queue to minimal objects (stream URLs are generated on demand). */
  function _saveQueueAndIndex() {
    const slim = queue.value.map((t) => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album,
      ...(t.coverArt !== undefined ? { coverArt: t.coverArt } : {}),
      duration: t.duration,
    }));
    localStorage.setItem("edgesonic:queue", JSON.stringify(slim));
    localStorage.setItem("edgesonic:currentIndex", String(index.value));
  }

  let _lastTimeSave = 0;

  // Restore persisted state on store init (runs once, synchronously).
  try {
    const rawQueue = localStorage.getItem("edgesonic:queue");
    if (rawQueue) {
      const saved = JSON.parse(rawQueue) as Track[];
      if (Array.isArray(saved) && saved.length > 0) {
        const rawIdx = parseInt(localStorage.getItem("edgesonic:currentIndex") ?? "", 10);
        const savedIdx = isNaN(rawIdx) ? 0 : Math.min(Math.max(rawIdx, 0), saved.length - 1);
        const rawTime = parseFloat(localStorage.getItem("edgesonic:currentTime") ?? "");
        queue.value = saved;
        index.value = savedIdx;
        duration.value = saved[savedIdx].duration || 0;
        if (!isNaN(rawTime) && rawTime > 0) {
          _pendingRestoreTime = rawTime;
          currentTime.value = rawTime; // show saved position in UI immediately
        }
        // Audio is intentionally NOT initialized here; loadCurrent(true) runs
        // lazily on the first toggle() so streamUrl is generated fresh at play time.
      }
    }
  } catch { /* corrupt localStorage — skip silently */ }

  // Persist queue + index whenever either changes (deep: array mutations included).
  watch([queue, index], _saveQueueAndIndex, { deep: true });

  // Throttle currentTime writes to at most once per 5 s to avoid excessive I/O.
  watch(currentTime, () => {
    const now = Date.now();
    if (now - _lastTimeSave >= 5000) {
      localStorage.setItem("edgesonic:currentTime", String(Math.floor(currentTime.value)));
      _lastTimeSave = now;
    }
  });

  // Volume is already written in setVolume(); watch covers direct ref mutations.
  watch(volume, (v) => localStorage.setItem("edgesonic:volume", String(v)));

  return {
    queue, index, playing, currentTime, duration, volume, bufferedRanges,
    current, hasTrack, playMode, starred,
    setQueue, playAt, toggle, next, prev, seek, setVolume,
    cyclePlayMode, toggleStar, clear,
  };
});
