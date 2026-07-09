<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from "vue";
import { usePlayerStore, type Track } from "../stores/player";
import { useAuth, formatDuration, parseXmlInner } from "../api";

const player = usePlayerStore();
const { coverArtUrl, authFetch } = useAuth();

// Tracks the currently-active lyric line's DOM element (for scroll-into-view).
// Was previously declared in a separate bare <script> block, which is
// module-scope (shared across every instance of this component) rather than
// per-instance state, and confused vue-tsc's cross-block type inference for
// the template ref callback below (spurious "HTMLElement not assignable to
// null" error). Component-local `let` inside <script setup> is correct here.
let lyricsActiveEl: HTMLElement | null = null;

// ---- Playback mode button (114) — single button replacing the previous
// separate shuffle-toggle + repeat-cycle buttons.
const PLAYBACK_MODE_ICONS: Record<string, string> = {
  sequential: "➡", "repeat-all": "🔁", "repeat-one": "🔂", shuffle: "🔀",
};
const PLAYBACK_MODE_TITLES: Record<string, string> = {
  sequential: "顺序播放", "repeat-all": "列表循环", "repeat-one": "单曲循环", shuffle: "随机播放",
};
const playbackModeIcon = computed(() => PLAYBACK_MODE_ICONS[player.playbackMode]);
const playbackModeTitle = computed(() => PLAYBACK_MODE_TITLES[player.playbackMode]);

// ---- Lyrics ----
// `translation` holds a same-timestamp second line (094/parseLrc-style
// sources sometimes carry the original and its translation as two
// consecutive lines sharing one [mm:ss.xx] tag — see groupLyricLines below).
interface LyricLine { time: number; text: string; translation?: string }
const lyrics = ref<LyricLine[]>([]);
const lyricsRaw = ref("");
const lyricsLoading = ref(false);
const lyricsError = ref("");
const hasSyncedLyrics = computed(() => lyrics.value.some((l) => l.time > 0));

// Some lyric sources interleave non-lyric content as a "{...}" line (JSON
// metadata / word-timing side channel we don't parse). Drop it the same way
// "[ti:]"/"[ar:]" LRC metadata tags are already dropped, rather than let it
// show up as a bogus line in the middle of the synced timeline.
function isJunkLine(text: string): boolean {
  return text.trim().startsWith("{");
}

// Group a time-sorted sequence of {time, text} entries: consecutive entries
// sharing the same timestamp are a same-time dual-track pair (original +
// translation), not two independent scrolling lines. The second (and any
// further) same-timestamp entry folds into the first line's `translation`.
function groupLyricLines(raw: Array<{ time: number; text: string }>): LyricLine[] {
  const out: LyricLine[] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r.time > 0 && Math.abs(last.time - r.time) < 0.001) {
      last.translation = last.translation ? `${last.translation}\n${r.text}` : r.text;
    } else {
      out.push({ time: r.time, text: r.text });
    }
  }
  return out;
}

// Parse a raw LRC blob — only used for the getLyrics artist/title fallback.
// getLyricsBySongId's structuredLyrics path (below) already carries per-line
// start offsets computed server-side and doesn't need re-deriving them from
// reconstructed text.
function parseLrc(text: string): LyricLine[] {
  const re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)/g;
  const raw: Array<{ time: number; text: string }> = [];
  let m: RegExpExecArray | null;
  let hasTimestamps = false;
  while ((m = re.exec(text)) !== null) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const ms = m[3] ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10) : 0;
    const line = m[4].trim();
    if (isJunkLine(line)) continue;
    hasTimestamps = true;
    raw.push({ time: min * 60 + sec + ms / 1000, text: line });
  }
  if (!hasTimestamps) {
    // No LRC timestamps → plain text lines (still drop junk lines).
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !isJunkLine(l)).map((text) => ({ time: 0, text }));
  }
  raw.sort((a, b) => a.time - b.time);
  return groupLyricLines(raw);
}

// 114 — auto-scroll the active line into view, backing off the moment the
// user manually scrolls the panel (browsing earlier/later lyrics shouldn't
// get yanked back to the current line mid-read) and resuming automatically
// after a few seconds of no further manual scrolling, or immediately via the
// floating "back to now playing" button. Declared before the lyrics-fetch
// watch below (which calls resumeAutoScroll on every track change) so
// `userScrolling`/`resumeTimer` are already initialized by the time that
// watch's `immediate: true` callback runs synchronously during setup.
const userScrolling = ref(false);
let programmaticScroll = false;
let resumeTimer: number | null = null;

function scrollActiveIntoView() {
  if (!lyricsActiveEl) return;
  programmaticScroll = true;
  lyricsActiveEl.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => { programmaticScroll = false; }, 500);
}

function onLyricsScroll() {
  if (programmaticScroll) return; // our own scrollIntoView call, not the user
  userScrolling.value = true;
  if (resumeTimer !== null) window.clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => resumeAutoScroll(), 5000);
}

function resumeAutoScroll() {
  userScrolling.value = false;
  if (resumeTimer !== null) { window.clearTimeout(resumeTimer); resumeTimer = null; }
  nextTick(scrollActiveIntoView);
}

onUnmounted(() => {
  if (resumeTimer !== null) window.clearTimeout(resumeTimer);
});

// Fetch lyrics when current track changes
watch(() => player.current?.id, async (id) => {
  lyrics.value = [];
  lyricsRaw.value = "";
  lyricsError.value = "";
  resumeAutoScroll(); // new track — drop any manual-scroll override left over from the previous one
  if (!id) return;
  lyricsLoading.value = true;
  try {
    const xml = await authFetch("getLyricsBySongId", { id });
    // Extract structuredLyrics → line elements
    const inner = parseXmlInner(xml, "structuredLyrics");
    if (inner) {
      // 114 — parse each <line start="ms">text</line>'s `start` attribute
      // directly instead of discarding it. The previous version only kept
      // each <line>'s text, joined them with "\n", and re-ran a
      // "[mm:ss.xx]"-timestamp regex over that reconstructed blob — but the
      // server already strips those bracket tags out of `value` before
      // emitting <line>, so the regex could never match anything and every
      // song silently fell back to unsynced plain-text display, even though
      // the server had perfectly good per-line `start` offsets all along.
      const lineRe = /<line([^>]*)>([\s\S]*?)<\/line>/g;
      let m: RegExpExecArray | null;
      const raw: Array<{ time: number; text: string }> = [];
      while ((m = lineRe.exec(inner)) !== null) {
        const startMatch = m[1].match(/start="(\d+)"/);
        const text = decodeEntities(m[2]).trim();
        if (!text || isJunkLine(text)) continue;
        raw.push({
          time: startMatch ? parseInt(startMatch[1], 10) / 1000 : 0,
          text,
        });
      }
      lyrics.value = groupLyricLines(raw);
      lyricsRaw.value = raw.map((r) => r.text).join("\n");
    } else {
      // Try getLyrics endpoint (artist+title based, raw LRC blob)
      const t = player.current;
      if (t) {
        const xml2 = await authFetch("getLyrics", { artist: t.artist, title: t.title });
        const inner2 = parseXmlInner(xml2, "lyrics");
        if (inner2) {
          lyricsRaw.value = decodeEntities(inner2);
          lyrics.value = parseLrc(lyricsRaw.value);
        }
      }
    }
  } catch {
    lyricsError.value = "歌词加载失败";
  } finally {
    lyricsLoading.value = false;
  }
}, { immediate: true });

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ---- Synced lyrics scroll ----
const activeLyricIdx = computed(() => {
  if (lyrics.value.length === 0) return -1;
  const t = player.currentTime;
  let idx = -1;
  for (let i = 0; i < lyrics.value.length; i++) {
    if (lyrics.value[i].time <= t) idx = i;
    else break;
  }
  return idx;
});

// Keep the lyrics panel following playback (state/functions declared above,
// before the lyrics-fetch watch).
watch(activeLyricIdx, () => {
  if (userScrolling.value) return;
  nextTick(scrollActiveIntoView);
});

// Click a synced line (or its play icon) to seek playback there.
function seekToLine(line: LyricLine) {
  if (!hasSyncedLyrics.value || line.time <= 0) return;
  player.seek(line.time);
  if (!player.playing) player.toggle();
}

const coverFailed = ref(false);
const track = computed(() => player.current);

// ---- Queue panel (right-bottom) ----
const queueOpen = ref(false);

function playFromQueue(i: number) {
  player.playAt(i);
}

function removeFromQueue(i: number) {
  // Simple: if it's before current, index stays; if after, index stays; if current, next plays
  if (i === player.index) return; // don't remove current
  player.queue.splice(i, 1);
  if (i < player.index) player.index--;
}

function formatT(sec: number): string {
  return formatDuration(sec);
}
</script>

<template>
  <div class="nowplaying">
    <!-- Left: cover + song info -->
    <div class="np-left">
      <div class="np-cover-wrap">
        <!-- 400 isn't in the backend's ALLOWED_COVER_SIZES allow-list
             (64/96/128/192/256/384/512 — media.ts parseCoverSize), so a
             request with size=400 silently fell through to the uncached
             "serve the original file" path: every play served the full-size
             original instead of a cached thumbnail. 512 is the closest
             allowed size at or above this box's 400px CSS width. -->
        <img
          v-if="track?.coverArt && !coverFailed"
          :src="coverArtUrl(track.coverArt, 512)"
          class="np-cover"
          @error="coverFailed = true"
          alt="cover"
        />
        <div v-else class="np-cover-placeholder">
          <span>♪</span>
        </div>
      </div>
      <div class="np-track-info">
        <div class="np-title">{{ track?.title || "—" }}</div>
        <div class="np-artist">{{ track?.artist || "" }}</div>
        <div class="np-album" v-if="track?.album">{{ track.album }}</div>
      </div>
      <div class="np-progress-wrap">
        <span class="np-time">{{ formatT(player.currentTime) }}</span>
        <input
          type="range"
          class="np-seek"
          min="0"
          :max="player.duration || 0"
          :value="player.currentTime"
          step="0.5"
          @input="player.seek(parseFloat(($event.target as HTMLInputElement).value))"
        />
        <span class="np-time">{{ formatT(player.duration) }}</span>
      </div>
      <div class="np-controls">
        <!-- 114 — single playback-mode button, replacing the separate
             shuffle-toggle + repeat-cycle buttons: 顺序播放→列表循环→单曲循环→随机播放→… -->
        <button
          class="np-btn"
          :class="{ active: player.playbackMode !== 'sequential' }"
          @click="player.cyclePlaybackMode"
          :title="playbackModeTitle"
        >{{ playbackModeIcon }}</button>
        <button class="np-btn" @click="player.prev" title="上一首">⏮</button>
        <button class="np-btn np-play" @click="player.toggle" :disabled="!player.hasTrack">
          {{ player.playing ? '⏸' : '▶' }}
        </button>
        <button class="np-btn" @click="player.next" title="下一首">⏭</button>
      </div>
    </div>

    <!-- Right: lyrics -->
    <div class="np-right">
      <div v-if="lyricsLoading" class="np-lyrics-loading">加载歌词中…</div>
      <div v-else-if="lyricsError" class="np-lyrics-error">{{ lyricsError }}</div>
      <div v-else-if="lyrics.length === 0" class="np-lyrics-empty">暂无歌词</div>
      <template v-else>
        <div class="np-lyrics-scroll" @scroll="onLyricsScroll">
          <div
            v-for="(line, i) in lyrics"
            :key="i"
            class="np-lyric-line"
            :class="{ active: hasSyncedLyrics && i === activeLyricIdx, seekable: hasSyncedLyrics && line.time > 0 }"
            :ref="el => { if (i === activeLyricIdx) lyricsActiveEl = (el as HTMLElement) }"
            @click="seekToLine(line)"
          >
            <span class="np-lyric-text">{{ line.text }}</span>
            <!-- 同一时间戳的第二行视为翻译，展示在原文下方 -->
            <span v-if="line.translation" class="np-lyric-translation">{{ line.translation }}</span>
            <span v-if="hasSyncedLyrics && line.time > 0" class="np-lyric-play" title="跳转到此处播放">▶</span>
          </div>
        </div>
        <!-- 114 — appears once the user manually scrolls the lyrics away from
             the live position; jumps back to the active line and resumes
             auto-follow. -->
        <transition name="queue-slide">
          <button v-if="userScrolling" class="np-lyrics-resume" @click="resumeAutoScroll">⟲ 回到当前播放</button>
        </transition>
      </template>
    </div>

    <!-- Queue panel (bottom-right) -->
    <div class="np-queue-fab" @click="queueOpen = !queueOpen" :class="{ hidden: queueOpen }">
      ☰ <span class="np-queue-count">{{ player.queue.length }}</span>
    </div>
    <transition name="queue-slide">
      <div v-if="queueOpen" class="np-queue-panel">
        <div class="np-queue-header">
          <span>播放列表 ({{ player.queue.length }})</span>
          <button class="np-queue-close" @click="queueOpen = false">×</button>
        </div>
        <div class="np-queue-list">
          <div
            v-for="(t, i) in player.queue"
            :key="t.id + '-' + i"
            class="np-queue-item"
            :class="{ playing: i === player.index }"
            @dblclick="playFromQueue(i)"
          >
            <span class="np-queue-title" @click="playFromQueue(i)">{{ t.title }}</span>
            <span class="np-queue-artist">{{ t.artist }}</span>
            <span class="np-queue-dur">{{ formatT(t.duration) }}</span>
            <button v-if="i !== player.index" class="np-queue-rm" @click.stop="removeFromQueue(i)">×</button>
          </div>
          <div v-if="player.queue.length === 0" class="np-queue-empty">播放列表为空</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.nowplaying {
  display: flex;
  min-height: calc(100vh - var(--nav-h) - var(--player-h));
  padding: 2.5rem 2rem 1rem;
  gap: 2rem;
}

/* Left: cover + controls */
.np-left {
  flex: 0 0 360px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.2rem;
}
.np-cover-wrap {
  width: 320px;
  height: 320px;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  background: var(--color-bg-tertiary);
}
.np-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.np-cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 4rem;
  color: var(--color-text-muted);
}
.np-track-info {
  text-align: center;
}
.np-title {
  font-size: 1.3rem;
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: 0.3rem;
}
.np-artist {
  font-size: 1rem;
  color: var(--color-text-secondary);
}
.np-album {
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
}
.np-progress-wrap {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  max-width: 320px;
}
.np-time {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  min-width: 2.5rem;
  text-align: center;
}
.np-seek {
  flex: 1;
  height: 4px;
  appearance: none;
  background: var(--color-border);
  border-radius: 2px;
  cursor: pointer;
}
.np-seek::-webkit-slider-thumb {
  appearance: none;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: var(--color-accent-primary);
  cursor: pointer;
}
.np-controls {
  display: flex;
  align-items: center;
  gap: 0.8rem;
}
.np-btn {
  background: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  width: 42px; height: 42px;
  color: var(--color-text-secondary);
  font-size: 1.1rem;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}
.np-btn:hover { color: var(--color-text-primary); border-color: var(--color-accent-dim); }
.np-btn.active { color: var(--color-accent-primary); border-color: var(--color-accent-primary); }
.np-btn:disabled { opacity: 0.4; cursor: default; }
.np-play {
  width: 56px; height: 56px;
  font-size: 1.4rem;
  border-color: var(--color-accent-primary);
  color: var(--color-accent-primary);
}

/* Right: lyrics */
.np-right {
  position: relative;
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.np-lyrics-loading, .np-lyrics-error, .np-lyrics-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
  font-size: 1rem;
}
.np-lyrics-scroll {
  overflow-y: auto;
  padding: 1rem 0;
  max-height: 100%;
  scroll-behavior: smooth;
}
.np-lyric-line {
  position: relative;
  padding: 0.5rem 2.4rem 0.5rem 0;
  font-size: 1.05rem;
  color: var(--color-text-muted);
  transition: color 0.3s, transform 0.3s;
  line-height: 1.6;
}
.np-lyric-line.seekable { cursor: pointer; }
.np-lyric-line.active {
  color: var(--color-accent-primary);
  font-size: 1.2rem;
  font-weight: 500;
  transform: scale(1.02);
}
.np-lyric-text { display: block; }
/* 114 — same-timestamp second line (original + translation pair). */
.np-lyric-translation {
  display: block;
  font-size: 0.82em;
  color: var(--color-text-muted);
  opacity: 0.85;
  margin-top: 0.15rem;
}
/* 114 — hover-revealed "seek here" affordance on the right of each line. */
.np-lyric-play {
  position: absolute;
  right: 0.4rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.8em;
  color: var(--color-accent-primary);
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.np-lyric-line.seekable:hover .np-lyric-play { opacity: 1; }

/* 114 — "back to now playing" floating button, shown while the user has
   manually scrolled the lyrics panel away from the active line. */
.np-lyrics-resume {
  position: absolute;
  bottom: 1rem;
  right: 1rem;
  padding: 0.5rem 1rem;
  background: var(--color-accent-primary);
  color: var(--color-bg-primary, #16161a);
  border: none;
  border-radius: 20px;
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  z-index: 5;
}
.np-lyrics-resume:hover { filter: brightness(1.1); }

/* Queue panel (bottom-right) */
.np-queue-fab {
  position: fixed;
  bottom: calc(var(--player-h) + 1rem);
  right: 1rem;
  z-index: 300;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.5rem 1rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 24px;
  cursor: pointer;
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  transition: opacity 0.2s;
}
.np-queue-fab:hover { border-color: var(--color-accent-dim); }
.np-queue-fab.hidden { opacity: 0; pointer-events: none; }
.np-queue-count {
  background: var(--color-accent-dim);
  color: var(--color-text-primary);
  border-radius: 10px;
  padding: 0 0.4rem;
  font-size: var(--fs-xs);
}

.np-queue-panel {
  position: fixed;
  bottom: calc(var(--player-h) + 1rem);
  right: 1rem;
  z-index: 301;
  width: 400px;
  max-height: 50vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  overflow: hidden;
}
.np-queue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.8rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
}
.np-queue-close {
  background: none;
  border: none;
  font-size: 1.4rem;
  color: var(--color-text-muted);
  cursor: pointer;
  line-height: 1;
}
.np-queue-list {
  overflow-y: auto;
  flex: 1;
}
.np-queue-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 1rem;
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
}
.np-queue-item:hover { background: var(--color-bg-tertiary); }
.np-queue-item.playing { color: var(--color-accent-primary); }
.np-queue-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-queue-artist { flex: 0 0 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-xs); }
.np-queue-dur { font-family: var(--font-mono); font-size: var(--fs-xs); }
.np-queue-rm {
  background: none; border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 1.1rem;
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
}
.np-queue-rm:hover { background: var(--color-accent-dim); color: var(--color-text-primary); }
.np-queue-empty {
  text-align: center;
  padding: 2rem;
  color: var(--color-text-muted);
}

/* Transition */
.queue-slide-enter-active, .queue-slide-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.queue-slide-enter-from, .queue-slide-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

/* Mobile */
@media (max-width: 768px) {
  .nowplaying { flex-direction: column; padding: 1rem; gap: 1rem; }
  .np-left { flex: none; }
  .np-cover-wrap { width: 200px; height: 200px; }
  .np-right { min-height: 300px; }
  .np-queue-panel { width: calc(100% - 2rem); }
}
</style>