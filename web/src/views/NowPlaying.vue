<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import { usePlayerStore } from "../stores/player";
import { useAuth, parseXmlInner } from "../api";

const player = usePlayerStore();
const { coverArtUrl, authFetch } = useAuth();

// ---- Time format mm:ss.xx ----
function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "00:00.00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// ---- Lyrics: original + translation (dual axis) ----
interface LyricLine { time: number; text: string; tr?: string }
const lyrics = ref<LyricLine[]>([]);
const lyricsLoading = ref(false);
const lyricsError = ref("");
const hasSynced = computed(() => lyrics.value.some((l) => l.time > 0));
const userScrolled = ref(false);
const autoScrollTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const lyricsScrollEl = ref<HTMLElement | null>(null);

// Parse LRC into timed lines. Handles dual-language LRC where original and
// translation alternate at the same timestamp.
function parseLrcDual(text: string): LyricLine[] {
  const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/g;
  const byTime = new Map<number, { text: string; tr?: string }>();
  let m: RegExpExecArray | null;
  let hasTs = false;
  const ordered: LyricLine[] = [];
  while ((m = re.exec(text)) !== null) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
    const time = min * 60 + sec + ms / 1000;
    const content = m[4].trim();
    hasTs = true;
    const existing = byTime.get(time);
    if (existing) {
      // Same timestamp → second line is translation
      if (!existing.tr) existing.tr = content;
    } else {
      const entry = { text: content, tr: undefined as string | undefined };
      byTime.set(time, entry);
      ordered.push({ time, text: content });
    }
  }
  if (!hasTs) {
    return text.split(/\r?\n/).filter((l) => l.trim()).map((t) => ({ time: 0, text: t }));
  }
  // Attach translations
  for (const entry of byTime.entries()) {
    const idx = ordered.findIndex((l) => l.time === entry[0]);
    if (idx >= 0) ordered[idx].tr = entry[1].tr;
  }
  return ordered.sort((a, b) => a.time - b.time);
}

// Detect if LRC has translation lines (same timestamp appears twice)
function extractTranslation(text: string): string | null {
  const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/g;
  const byTime = new Map<number, string[]>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const time = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (!byTime.has(time)) byTime.set(time, []);
    byTime.get(time)!.push(m[4].trim());
  }
  // Find first timestamp with 2 lines → second is translation
  for (const [, lines] of byTime) {
    if (lines.length >= 2) return lines[1];
  }
  return null;
}

// Fetch lyrics when track changes
watch(() => player.current?.id, async (id) => {
  lyrics.value = [];
  lyricsError.value = "";
  if (!id) return;
  lyricsLoading.value = true;
  try {
    const xml = await authFetch("getLyricsBySongId", { id });
    const inner = parseXmlInner(xml, "structuredLyrics");
    if (inner) {
      const lineRe = /<line[^>]*>([^<]*)<\/line>/g;
      let m: RegExpExecArray | null;
      const text: string[] = [];
      while ((m = lineRe.exec(inner)) !== null) {
        text.push(decodeEntities(m[1]));
      }
      lyrics.value = parseLrcDual(text.join("\n"));
    } else {
      // fallback: getLyrics by artist+title
      const t = player.current;
      if (t) {
        const xml2 = await authFetch("getLyrics", { artist: t.artist, title: t.title });
        const inner2 = parseXmlInner(xml2, "lyrics");
        if (inner2) lyrics.value = parseLrcDual(decodeEntities(inner2));
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

// ---- Auto-scroll to active lyric ----
const activeIdx = computed(() => {
  if (!hasSynced.value) return -1;
  const t = player.currentTime;
  let idx = -1;
  for (let i = 0; i < lyrics.value.length; i++) {
    if (lyrics.value[i].time <= t) idx = i;
    else break;
  }
  return idx;
});

// Scroll active line to center. Paused for 5s after user scrolls manually.
watch(activeIdx, async (idx) => {
  if (idx < 0 || userScrolled.value || !lyricsScrollEl.value) return;
  await nextTick();
  const container = lyricsScrollEl.value;
  const el = container.children[idx] as HTMLElement | undefined;
  if (!el) return;
  const target = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
  container.scrollTo({ top: target, behavior: "smooth" });
});

function onLyricsScroll() {
  userScrolled.value = true;
  if (autoScrollTimer.value) clearTimeout(autoScrollTimer.value);
  autoScrollTimer.value = setTimeout(() => { userScrolled.value = false; }, 5000);
}

onUnmounted(() => {
  if (autoScrollTimer.value) clearTimeout(autoScrollTimer.value);
});

const coverFailed = ref(false);
const track = computed(() => player.current);
// coverArtUrl generates a fresh random salt each call; calling it in the
// template directly (e.g. :src="coverArtUrl(track.coverArt, 400)") re-fetches
// the cover image 4×/s because timeupdate → progressPct triggers re-render.
const coverSrc = computed(() => {
  const tr = track.value;
  return tr?.coverArt ? coverArtUrl(tr.coverArt, 400) : "";
});
watch(coverSrc, () => { coverFailed.value = false; });

// ---- Seek by dragging ----
const seeking = ref(false);
function onSeekStart(e: MouseEvent) {
  if (player.duration <= 0) return;
  seeking.value = true;
  seekFromEvent(e);
  const move = (ev: MouseEvent) => seekFromEvent(ev);
  const up = () => { seeking.value = false; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
function seekFromEvent(e: MouseEvent) {
  const el = document.getElementById("np-seek-bar");
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  player.seek(ratio * player.duration);
}

// Fast-forward / rewind 10s
function rewind10() { player.seek(Math.max(0, player.currentTime - 10)); }
function forward10() { player.seek(Math.min(player.duration, player.currentTime + 10)); }

const progressPct = computed(() => player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0);
</script>

<template>
  <div class="nowplaying">
    <!-- Left: cover + controls -->
    <div class="np-left">
      <div class="np-cover-wrap">
        <img v-if="coverSrc && !coverFailed" :src="coverSrc" class="np-cover" @error="coverFailed = true" alt="cover" />
        <div v-else class="np-cover-placeholder"><span class="np-placeholder-icon" v-html="'<svg viewBox=\'0 0 24 24\' width=\'48\' height=\'48\'><path fill=\'currentColor\' d=\'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z\'/></svg>'"></span></div>
      </div>
      <div class="np-track-info">
        <div class="np-title">{{ track?.title || "—" }}</div>
        <div class="np-artist">{{ track?.artist || "" }}</div>
        <div class="np-album" v-if="track?.album">{{ track.album }}</div>
      </div>

      <!-- Progress bar -->
      <div class="np-progress-bar" id="np-seek-bar" @mousedown="onSeekStart">
        <div class="np-progress-fill" :style="{ width: progressPct + '%' }"></div>
      </div>
      <div class="np-time-row">
        <span class="np-time">{{ fmtTime(player.currentTime) }}</span>
        <span class="np-time">{{ fmtTime(player.duration) }}</span>
      </div>

      <!-- Controls: centered, ff/rewind symmetric -->
      <div class="np-controls">
        <button class="np-btn" :class="{ active: player.shuffle }" :disabled="!player.hasTrack" @click="player.toggleShuffle()" title="随机">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17L10.59 9.17zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.92 7.41-1.42 1.42 3.54 3.54L20 14.5V20h-5.5l2.04-2.04-3.12-3.12z"/></svg>
        </button>
        <button class="np-btn" :disabled="!player.hasTrack" @click="rewind10" title="快退10秒">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z"/></svg>
        </button>
        <button class="np-btn" :disabled="!player.hasTrack" @click="player.prev()" title="上一首">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z"/></svg>
        </button>
        <button class="np-btn np-play" @click="player.toggle()" :disabled="!player.hasTrack">
          <svg v-if="player.playing" viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8 5v14l11-7L8 5z"/></svg>
        </button>
        <button class="np-btn" :disabled="!player.hasTrack" @click="player.next()" title="下一首">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
        </button>
        <button class="np-btn" :disabled="!player.hasTrack" @click="forward10" title="快进10秒">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M4 18l8.5-6L4 6v12zm9.5-12v12L22 12l-8.5-6z"/></svg>
        </button>
        <button class="np-btn" :class="{ active: player.repeatMode !== 'off' }" :disabled="!player.hasTrack" @click="player.toggleRepeat()" :title="player.repeatMode === 'one' ? '单曲循环' : player.repeatMode === 'all' ? '列表循环' : '关闭循环'">
          <svg v-if="player.repeatMode === 'one'" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="9" y="17" fill="currentColor" font-size="8" font-weight="bold">1</text></svg>
          <svg v-else viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
        </button>
      </div>
    </div>

    <!-- Right: lyrics with auto-scroll + translation -->
    <div class="np-right" @scroll.passive="onLyricsScroll">
      <div v-if="lyricsLoading" class="np-lyrics-status">加载歌词中…</div>
      <div v-else-if="lyricsError" class="np-lyrics-status">{{ lyricsError }}</div>
      <div v-else-if="lyrics.length === 0" class="np-lyrics-status">暂无歌词</div>
      <div v-else ref="lyricsScrollEl" class="np-lyrics-scroll">
        <div class="np-lyrics-spacer"></div>
        <div
          v-for="(line, i) in lyrics"
          :key="i"
          class="np-lyric-line"
          :class="{ active: hasSynced && i === activeIdx }"
        >
          <div class="np-lyric-original">{{ line.text }}</div>
          <div v-if="line.tr" class="np-lyric-translation">{{ line.tr }}</div>
        </div>
        <div class="np-lyrics-spacer"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nowplaying {
  display: flex;
  height: calc(100vh - var(--nav-h) - var(--player-h));
  padding: 1.5rem 1.5rem 0.5rem;
  gap: 1.5rem;
  overflow: hidden;
}

/* Left: cover + controls */
.np-left {
  flex: 0 0 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
}
.np-cover-wrap {
  width: 280px;
  height: 280px;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  background: var(--color-bg-tertiary);
}
.np-cover { width: 100%; height: 100%; object-fit: cover; display: block; }
.np-cover-placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  color: var(--color-text-muted);
}
.np-track-info { text-align: center; }
.np-title { font-size: 1.2rem; font-weight: 600; color: var(--color-text-primary); margin-bottom: 0.2rem; }
.np-artist { font-size: 0.95rem; color: var(--color-text-secondary); }
.np-album { font-size: var(--fs-sm); color: var(--color-text-muted); margin-top: 0.1rem; }

/* Progress bar */
.np-progress-bar {
  width: 100%; max-width: 300px;
  height: 4px;
  background: var(--color-border);
  border-radius: 2px;
  cursor: pointer;
  position: relative;
}
.np-progress-fill {
  height: 100%;
  background: var(--color-accent-primary);
  border-radius: 2px;
  transition: width 0.1s linear;
}
.np-time-row {
  display: flex;
  justify-content: space-between;
  width: 100%; max-width: 300px;
}
.np-time {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}

/* Controls */
.np-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.np-btn {
  background: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  width: 38px; height: 38px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.np-btn:hover:not(:disabled) { color: var(--color-text-primary); border-color: var(--color-accent-dim); }
.np-btn.active { color: var(--color-accent-primary); border-color: var(--color-accent-primary); }
.np-btn:disabled { opacity: 0.3; cursor: default; }
.np-play {
  width: 52px; height: 52px;
  border-color: var(--color-accent-primary);
  color: var(--color-accent-primary);
}

/* Right: lyrics */
.np-right {
  flex: 1;
  overflow-y: auto;
  position: relative;
  /* Custom scrollbar */
  scrollbar-width: thin;
  scrollbar-color: var(--color-accent-dim) transparent;
}
.np-right::-webkit-scrollbar { width: 6px; }
.np-right::-webkit-scrollbar-thumb { background: var(--color-accent-dim); border-radius: 3px; }
.np-right::-webkit-scrollbar-track { background: transparent; }

.np-lyrics-status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
  font-size: 1rem;
}
.np-lyrics-scroll {
  scroll-behavior: smooth;
}
.np-lyrics-spacer { height: 40vh; }
.np-lyric-line {
  padding: 0.6rem 1rem;
  text-align: center;
  transition: opacity 0.3s, color 0.3s, transform 0.3s;
  opacity: 0.4;
}
.np-lyric-line.active {
  opacity: 1;
  transform: scale(1.05);
}
.np-lyric-original {
  font-size: 1.05rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}
.np-lyric-line.active .np-lyric-original {
  color: var(--color-accent-primary);
  font-weight: 500;
  font-size: 1.2rem;
}
.np-lyric-translation {
  font-size: 0.9rem;
  color: var(--color-text-muted);
  margin-top: 0.2rem;
  line-height: 1.4;
}
.np-lyric-line.active .np-lyric-translation {
  color: var(--color-text-secondary);
}

/* Mobile */
@media (max-width: 768px) {
  .nowplaying { flex-direction: column; padding: 0.5rem; gap: 0.5rem; }
  .np-left { flex: none; }
  .np-cover-wrap { width: 180px; height: 180px; }
  .np-right { flex: 1; min-height: 200px; }
}
</style>