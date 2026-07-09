import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useAuth } from "../api";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverArt?: string;
  duration: number;
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

  // 110 — Playback modes: 'off' | 'one' | 'all' (repeat), shuffle boolean.
  type RepeatMode = "off" | "one" | "all";
  const repeatMode = ref<RepeatMode>(
    (localStorage.getItem("edgesonic:repeatMode") as RepeatMode) || "off"
  );
  const shuffle = ref(localStorage.getItem("edgesonic:shuffle") === "true");
  // Internal shuffle order — the actual queue array is never shuffled; instead
  // we maintain a parallel index order for shuffle playback.
  let _shuffleOrder: number[] = [];

  const current = computed<Track | null>(() => queue.value[index.value] || null);
  const hasTrack = computed(() => index.value >= 0 && index.value < queue.value.length);

  let elA: HTMLAudioElement | null = null;
  let elB: HTMLAudioElement | null = null;
  let active: HTMLAudioElement | null = null;
  let preloaded: { el: HTMLAudioElement; index: number } | null = null;
  // Pending seek position to restore after loadedmetadata fires (page-reload resume).
  let _pendingRestoreTime: number | null = null;

  function syncBuffered(el: HTMLAudioElement) {
    if (el !== active) return;
    const next: [number, number][] = [];
    try {
      for (let i = 0; i < el.buffered.length; i++) {
        const start = el.buffered.start(i);
        const end = el.buffered.end(i);
        if (end - start > 0.05) next.push([start, end]);
      }
    } catch { /* buffered not ready yet */ }
    // Shallow-compare to avoid ref churn when nothing moved.
    const prev = bufferedRanges.value;
    if (prev.length !== next.length ||
        next.some((r, i) => r[0] !== prev[i][0] || r[1] !== prev[i][1])) {
      bufferedRanges.value = next;
    }
  }

  function makeAudio(): HTMLAudioElement {
    const el = new Audio();
    // 093c — metadata: only fetch the header (duration + first frames) on
    // element creation. The browser fetches subsequent byte ranges on demand
    // as playback progresses, so a 64 MB FLAC doesn't get pulled into memory
    // in one shot. Combined with the R2 presign 302 cache, only the first
    // request hits the Worker; the rest go direct to R2 in seek-sized chunks.
    // Pre-buffering the next track (preloadNext) overrides this to "auto" so
    // the cross-fade swap stays instant.
    el.preload = "metadata";
    el.volume = volume.value;
    el.addEventListener("timeupdate", () => { if (el === active) currentTime.value = el.currentTime; });
    el.addEventListener("durationchange", () => {
      if (el === active && isFinite(el.duration)) duration.value = el.duration;
    });
    el.addEventListener("play", () => { if (el === active) playing.value = true; });
    el.addEventListener("pause", () => { if (el === active) playing.value = false; });
    el.addEventListener("ended", () => { if (el === active) next(); });
    el.addEventListener("error", () => { if (el === active) playing.value = false; });
    el.addEventListener("progress", () => syncBuffered(el));
    // Start prebuffering the next track only once the current one can play —
    // a slow upstream shouldn't have to feed two streams during startup.
    el.addEventListener("canplay", () => { if (el === active) preloadNext(); });
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
      preloaded.el.removeAttribute("src");
      // Reset to metadata so the next reuse doesn't keep the auto preload.
      preloaded.el.preload = "metadata";
      preloaded.el.load();
      preloaded = null;
    }
  }

  /** Prebuffer the next queue entry into the inactive element. */
  function preloadNext() {
    ensureElements();
    const ni = index.value + 1;
    if (ni >= queue.value.length) { invalidatePreload(); return; }
    if (preloaded?.index === ni) return;
    invalidatePreload();
    const { streamUrl } = useAuth();
    const el = inactiveEl();
    // Aggressive preload for the upcoming track so the cross-fade swap is
    // instant. The active element keeps "metadata" so it doesn't pull the
    // whole file when the user is just scrubbing.
    el.preload = "auto";
    el.src = streamUrl(queue.value[ni].id);
    el.load();
    preloaded = { el, index: ni };
  }

  function loadCurrent(autoplay = true) {
    const track = current.value;
    if (!track) return;
    ensureElements();
    // If restoring a saved position, show it immediately; otherwise reset to 0.
    currentTime.value = _pendingRestoreTime ?? 0;
    duration.value = track.duration || 0;
    bufferedRanges.value = [];

    if (preloaded && preloaded.index === index.value) {
      // Swap in the prebuffered element — instant start
      const next = preloaded.el;
      preloaded = null;
      active!.pause();
      active!.removeAttribute("src");
      active!.load();
      active = next;
    } else {
      invalidatePreload();
      const { streamUrl } = useAuth();
      active!.pause();
      active!.src = streamUrl(track.id);
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
    return repeatMode.value === "all" ? _shuffleOrder[0] : -1;
  }

  function next() {
    if (repeatMode.value === "one") {
      // Repeat current track
      if (active) { active.currentTime = 0; void active.play().catch(() => {}); }
      return;
    }
    if (shuffle.value) {
      const ni = _shuffleNextIndex(index.value);
      if (ni >= 0) playAt(ni);
      else if (repeatMode.value === "all" && queue.value.length > 0) {
        _regenShuffleOrder();
        playAt(_shuffleOrder[0]);
      } else playing.value = false;
      return;
    }
    if (index.value < queue.value.length - 1) playAt(index.value + 1);
    else if (repeatMode.value === "all" && queue.value.length > 0) playAt(0);
    else playing.value = false;
  }

  function prev() {
    if (!active) return;
    // Restart current track if more than 3s in, like most players.
    if (active.currentTime > 3) { active.currentTime = 0; return; }
    if (shuffle.value) {
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

  function toggleRepeat() {
    repeatMode.value = repeatMode.value === "off" ? "all" : repeatMode.value === "all" ? "one" : "off";
    localStorage.setItem("edgesonic:repeatMode", repeatMode.value);
  }

  function toggleShuffle() {
    shuffle.value = !shuffle.value;
    localStorage.setItem("edgesonic:shuffle", String(shuffle.value));
    if (shuffle.value && queue.value.length > 0) _regenShuffleOrder();
    else _shuffleOrder = [];
  }

  /** Stop playback and clear queue (e.g. on logout). */
  function clear() {
    _pendingRestoreTime = null;
    invalidatePreload();
    for (const el of [elA, elB]) {
      if (el) { el.pause(); el.removeAttribute("src"); el.load(); }
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
    localStorage.removeItem("edgesonic:repeatMode");
    localStorage.removeItem("edgesonic:shuffle");
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
    current, hasTrack, repeatMode, shuffle,
    setQueue, playAt, toggle, next, prev, seek, setVolume,
    toggleRepeat, toggleShuffle, clear,
  };
});
