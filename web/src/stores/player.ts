import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useAuth, parseXmlAttrs } from "../api";

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
      const { authFetch } = useAuth();
      const xml = await authFetch("getSong", { id });
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

  // Preload the next track once the current one is within this many seconds
  // of ending, or past this fraction played — whichever comes first (so a
  // short track that's under NEXT_TRACK_PRELOAD_SECONDS total still starts
  // preloading right away instead of waiting for a 75% mark it may never
  // meaningfully clear). That timing gate is ANDed with "current track has
  // finished downloading" — both current and next now buffer the whole file
  // (preload="auto"), so starting the next download while the current one is
  // still mid-flight would have the two fight over the same connection's
  // bandwidth; waiting for the current track's own buffered range to reach
  // its end means the next-track fetch only starts once it has the pipe to
  // itself.
  const NEXT_TRACK_PRELOAD_SECONDS = 30;
  const NEXT_TRACK_PRELOAD_FRACTION = 0.75;

  function isFullyBuffered(el: HTMLAudioElement, dur: number): boolean {
    try {
      const n = el.buffered.length;
      return n > 0 && el.buffered.end(n - 1) >= dur - 0.5;
    } catch {
      return false;
    }
  }

  function makeAudio(): HTMLAudioElement {
    const el = new Audio();
    // Buffer the currently-playing track aggressively (whole file, not just
    // on-demand byte ranges) — reliable full playback matters more than
    // trimming memory use for the active track. The R2 presign 302 cache
    // means only the first request hits the Worker either way; the rest go
    // direct to R2.
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
      if (el === active && isFinite(el.duration)) duration.value = el.duration;
    });
    el.addEventListener("play", () => { if (el === active) playing.value = true; });
    el.addEventListener("pause", () => { if (el === active) playing.value = false; });
    el.addEventListener("ended", () => { if (el === active) next(); });
    el.addEventListener("error", () => { if (el === active) playing.value = false; });
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
    const { streamUrl } = useAuth();
    const el = inactiveEl();
    // preload="auto" — whole file, same as the active track — so the
    // cross-fade swap on next()/ended is instant and gapless.
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
