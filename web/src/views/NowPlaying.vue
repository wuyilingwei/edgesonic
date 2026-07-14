
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { usePlayerStore } from "../stores/player";
import { useAuth } from "../api";
import { getTrackLyrics } from "../lib/trackPrefetch";

const player = usePlayerStore();
const { coverArtUrl, authFetch, username } = useAuth();

interface LyricLine { time: number; text: string; tr?: string }
const lyrics = ref<LyricLine[]>([]);
const lyricsLoading = ref(false);
const lyricsError = ref("");
const hasSynced = computed(() => lyrics.value.some((l) => l.time > 0));
const userScrolled = ref(false);
const lyricsScrollEl = ref<HTMLElement | null>(null);
const suppressScrollUntil = ref(0);
const autoScrolling = ref(false);
const ACTIVE_CENTER_TOLERANCE_PX = 24;
let lyricsReturnTimer: ReturnType<typeof setTimeout> | null = null;

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

function parseStructuredLines(inner: string): LyricLine[] {
  const lineRe = /<line(?:\s+start="(\d+)")?[^>]*>([^<]*)<\/line>/g;
  let m: RegExpExecArray | null;
  const raw: { time: number; text: string; hasTime: boolean }[] = [];
  while ((m = lineRe.exec(inner)) !== null) {
    const hasTime = m[1] !== undefined;
    const content = decodeEntities(m[2]).trim();
    if (!content) continue;
    raw.push({ time: hasTime ? parseInt(m[1], 10) / 1000 : 0, text: content, hasTime });
  }
  const hasTs = raw.some((r) => r.hasTime);
  if (!hasTs) {
    // Unsynced lyrics: every line is its own entry, no timestamp grouping.
    return raw.map((r) => ({ time: 0, text: r.text }));
  }
  // Synced: consecutive lines sharing the same timestamp are the
  // original+translation LRC convention — group the second under the first.
  const byTime = new Map<number, { text: string; tr?: string }>();
  const ordered: LyricLine[] = [];
  for (const r of raw) {
    const existing = byTime.get(r.time);
    if (existing) {
      if (!existing.tr) existing.tr = r.text;
    } else {
      const entry = { text: r.text, tr: undefined as string | undefined };
      byTime.set(r.time, entry);
      ordered.push({ time: r.time, text: r.text });
    }
  }
  for (const [time, entry] of byTime.entries()) {
    const idx = ordered.findIndex((l) => l.time === time);
    if (idx >= 0) ordered[idx].tr = entry.tr;
  }
  return ordered.sort((a, b) => a.time - b.time);
}

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

let lyricsRequest = 0;
function resetLyricsScroll() {
  lyricsScrollEl.value?.scrollTo({ top: 0, behavior: "auto" });
}

watch(() => player.current?.id, async (id) => {
  const request = ++lyricsRequest;
  const trackAtChange = player.current;
  userScrolled.value = false;
  suppressScrollUntil.value = Date.now() + 600;
  autoScrolling.value = false;
  lyrics.value = [];
  lyricsError.value = "";
  lyricsLoading.value = !!id;
  resetLyricsScroll();
  await nextTick();
  if (request !== lyricsRequest) return;
  resetLyricsScroll();
  if (!id || !trackAtChange || trackAtChange.id !== id) {
    lyricsLoading.value = false;
    return;
  }
  try {
    const payload = await getTrackLyrics(trackAtChange, { authFetch, scope: username.value });
    if (request !== lyricsRequest) return;
    if (payload.structured) lyrics.value = parseStructuredLines(payload.structured);
    else if (payload.lrc) lyrics.value = parseLrcDual(decodeEntities(payload.lrc));
  } catch {
    if (request === lyricsRequest) lyricsError.value = "歌词加载失败";
  } finally {
    if (request === lyricsRequest) lyricsLoading.value = false;
  }
}, { immediate: true });

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

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

async function centerActiveLyric(idx = activeIdx.value) {
  if (idx < 0 || userScrolled.value || !lyricsScrollEl.value) return;
  await nextTick();
  const container = lyricsScrollEl.value;
  if (!container) return;
  const el = container.querySelectorAll(".np-lyric-line")[idx] as HTMLElement | undefined;
  if (!el) return;
  const target = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
  suppressScrollUntil.value = Date.now() + 600;
  autoScrolling.value = true;
  container.scrollTo({ top: target, behavior: "smooth" });
  setTimeout(() => { autoScrolling.value = false; }, 600);
}

watch(activeIdx, (idx) => {
  void centerActiveLyric(idx);
});

function onLyricsScroll() {
  if (Date.now() < suppressScrollUntil.value) return;
  userScrolled.value = !activeLineIsCentered();
  if (!userScrolled.value) return;
  if (lyricsReturnTimer) clearTimeout(lyricsReturnTimer);
  lyricsReturnTimer = setTimeout(() => {
    userScrolled.value = false;
    void centerActiveLyric();
  }, 1200);
}

onBeforeUnmount(() => { if (lyricsReturnTimer) clearTimeout(lyricsReturnTimer); });

function activeLineIsCentered(): boolean {
  const idx = activeIdx.value;
  const container = lyricsScrollEl.value;
  if (idx < 0 || !container) return false;
  const el = container.querySelectorAll(".np-lyric-line")[idx] as HTMLElement | undefined;
  if (!el) return false;
  const activeCenter = el.offsetTop + el.clientHeight / 2;
  const viewportCenter = container.scrollTop + container.clientHeight / 2;
  return Math.abs(activeCenter - viewportCenter) <= ACTIVE_CENTER_TOLERANCE_PX;
}

function onLyricClick(line: LyricLine) {
  if (!hasSynced.value || !player.hasTrack) return;
  userScrolled.value = false;
  player.seek(line.time);
  if (!player.playing) player.toggle();
}

const coverFailed = ref(false);
const track = computed(() => player.current);
const coverSrc = computed(() => {
  const tr = track.value;
  return tr?.coverArt ? coverArtUrl(tr.coverArt, 512) : "";
});
watch(coverSrc, () => { coverFailed.value = false; });

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

    </div>

    <!-- Right: lyrics with auto-scroll + translation -->
    <div class="np-right" :class="{ 'auto-scrolling': autoScrolling }" ref="lyricsScrollEl" @scroll.passive="onLyricsScroll">
      <div v-if="lyricsLoading" class="np-lyrics-status">加载歌词中…</div>
      <div v-else-if="lyricsError" class="np-lyrics-status">{{ lyricsError }}</div>
      <div v-else-if="lyrics.length === 0" class="np-lyrics-status">暂无歌词</div>
      <div v-else class="np-lyrics-scroll">
        <div class="np-lyrics-spacer"></div>
        <div
          v-for="(line, i) in lyrics"
          :key="i"
          class="np-lyric-line"
          :class="{ active: hasSynced && i === activeIdx, clickable: hasSynced }"
          @click="onLyricClick(line)"
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
  position: relative;
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
  position: relative;
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


/* Right: lyrics */
.np-right {
  flex: 1;
  overflow-y: auto;
  position: relative;
  scrollbar-width: none;
}
.np-right::-webkit-scrollbar { display: none; }

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
.np-lyric-line.clickable { cursor: pointer; }
.np-lyric-line.clickable:hover { opacity: 0.75; }
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
  .np-cover-wrap { width: min(180px, 28vh); height: min(180px, 28vh); }
  .np-right { flex: 1; min-height: 0; }
}
</style>
