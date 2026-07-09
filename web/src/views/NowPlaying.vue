<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
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

// ---- Lyrics ----
interface LyricLine { time: number; text: string }
const lyrics = ref<LyricLine[]>([]);
const lyricsRaw = ref("");
const lyricsLoading = ref(false);
const lyricsError = ref("");
const hasSyncedLyrics = computed(() => lyrics.value.some((l) => l.time > 0));

// Parse LRC format into timed lines
function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/g;
  let m: RegExpExecArray | null;
  let hasTimestamps = false;
  while ((m = re.exec(text)) !== null) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
    const time = min * 60 + sec + ms / 1000;
    hasTimestamps = true;
    lines.push({ time, text: m[4].trim() });
  }
  if (!hasTimestamps) {
    // No LRC timestamps → plain text lines
    return text.split(/\r?\n/).filter((l) => l.trim()).map((text) => ({ time: 0, text }));
  }
  return lines.sort((a, b) => a.time - b.time);
}

// Fetch lyrics when current track changes
watch(() => player.current?.id, async (id) => {
  lyrics.value = [];
  lyricsRaw.value = "";
  lyricsError.value = "";
  if (!id) return;
  lyricsLoading.value = true;
  try {
    const xml = await authFetch("getLyricsBySongId", { id });
    // Extract structuredLyrics → line elements
    const inner = parseXmlInner(xml, "structuredLyrics");
    if (inner) {
      const lineRe = /<line[^>]*>([^<]*)<\/line>/g;
      let m: RegExpExecArray | null;
      const text: string[] = [];
      while ((m = lineRe.exec(inner)) !== null) {
        text.push(decodeEntities(m[1]));
      }
      lyricsRaw.value = text.join("\n");
    } else {
      // fallback to getLyrics (artist+title based)
    }
    if (lyricsRaw.value) lyrics.value = parseLrc(lyricsRaw.value);
    else if (!inner) {
      // Try getLyrics endpoint
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
        <button class="np-btn" :class="{ active: player.shuffle }" @click="player.toggleShuffle" title="随机">🔀</button>
        <button class="np-btn" @click="player.prev" title="上一首">⏮</button>
        <button class="np-btn np-play" @click="player.toggle" :disabled="!player.hasTrack">
          {{ player.playing ? '⏸' : '▶' }}
        </button>
        <button class="np-btn" @click="player.next" title="下一首">⏭</button>
        <button class="np-btn" :class="{ active: player.repeatMode !== 'off' }" @click="player.toggleRepeat" title="循环">
          {{ player.repeatMode === 'one' ? '🔂' : '🔁' }}
        </button>
      </div>
    </div>

    <!-- Right: lyrics -->
    <div class="np-right">
      <div v-if="lyricsLoading" class="np-lyrics-loading">加载歌词中…</div>
      <div v-else-if="lyricsError" class="np-lyrics-error">{{ lyricsError }}</div>
      <div v-else-if="lyrics.length === 0" class="np-lyrics-empty">暂无歌词</div>
      <div v-else class="np-lyrics-scroll" ref="lyricsContainer">
        <div
          v-for="(line, i) in lyrics"
          :key="i"
          class="np-lyric-line"
          :class="{ active: hasSyncedLyrics && i === activeLyricIdx }"
          :ref="el => { if (i === activeLyricIdx) lyricsActiveEl = (el as HTMLElement) }"
        >{{ line.text }}</div>
      </div>
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
  padding: 0.5rem 0;
  font-size: 1.05rem;
  color: var(--color-text-muted);
  transition: color 0.3s, transform 0.3s;
  line-height: 1.6;
}
.np-lyric-line.active {
  color: var(--color-accent-primary);
  font-size: 1.2rem;
  font-weight: 500;
  transform: scale(1.02);
}

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