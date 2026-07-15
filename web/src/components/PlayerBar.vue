
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter, useRoute } from "vue-router";
import { usePlayerStore } from "../stores/player";
import { useAuth, formatDuration } from "../api";
import { activeTheme } from "../theme";
import { getTheme } from "../themes/registry";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const player = usePlayerStore();
const { coverArtUrl } = useAuth();

const activeThemeDef = computed(() => getTheme(activeTheme.value));

let lastRoute = "/library";
watch(() => route.path, (p) => { if (p !== "/now-playing") lastRoute = p; }, { immediate: true });
const detailsOpen = computed(() => route.path === "/now-playing");

let trackTouchStart: { x: number; y: number } | null = null;
let suppressTrackClickUntil = 0;

function onTrackTouchStart(e: TouchEvent) {
  const touch = e.changedTouches[0];
  if (!touch) return;
  trackTouchStart = { x: touch.clientX, y: touch.clientY };
}

function onTrackTouchEnd(e: TouchEvent) {
  const start = trackTouchStart;
  trackTouchStart = null;
  if (!start || detailsOpen.value || !player.hasTrack) return;
  const touch = e.changedTouches[0];
  if (!touch) return;
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
  suppressTrackClickUntil = Date.now() + 400;
  if (dx < 0) player.next();
  else player.prev(true);
}

function onTrackTouchCancel() {
  trackTouchStart = null;
}

function goNowPlaying() {
  if (Date.now() < suppressTrackClickUntil) return;
  if (!player.hasTrack) return;
  if (route.path === "/now-playing") router.push(lastRoute);
  else router.push("/now-playing");
}

const playModeTitle = computed(() => t(`player.playMode.${player.playMode}`));
const expandTitle = computed(() => t(detailsOpen.value ? "player.collapse" : "player.expand"));

const coverFailed = ref(false);
const coverSrc = computed(() => {
  const tr = player.current;
  return tr?.coverArt ? coverArtUrl(tr.coverArt, 96) : "";
});
watch(coverSrc, () => { coverFailed.value = false; });

const bufferedSegments = computed(() => {
  if (player.duration <= 0) return [] as { left: number; width: number }[];
  return player.bufferedRanges.map(([s, e]) => ({
    left: Math.min(Math.max((s / player.duration) * 100, 0), 100),
    width: Math.min(Math.max(((e - s) / player.duration) * 100, 0), 100),
  }));
});

const progressEl = ref<HTMLElement | null>(null);
const dragging = ref(false);
const dragTime = ref<number | null>(null);

const displayTime = computed(() => dragTime.value ?? player.currentTime);
const progressPct = computed(() =>
  player.duration > 0 ? (displayTime.value / player.duration) * 100 : 0,
);
const coverProgressPct = computed(() => Math.min(Math.max(progressPct.value, 0), 100));

function fmtPrecise(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00.00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function seekFromEvent(e: PointerEvent): number | null {
  const el = progressEl.value;
  if (!el || player.duration <= 0) return null;
  const rect = el.getBoundingClientRect();
  const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  return ratio * player.duration;
}

let removeDragListeners: (() => void) | null = null;

function stopProgressDrag(commit: boolean) {
  const target = dragTime.value;
  dragTime.value = null;
  dragging.value = false;
  removeDragListeners?.();
  removeDragListeners = null;
  if (commit && target !== null) player.seek(target);
}

function onProgressPointerDown(e: PointerEvent) {
  if (!player.hasTrack) return;
  e.preventDefault();
  stopProgressDrag(false);
  progressEl.value?.setPointerCapture?.(e.pointerId);
  dragging.value = true;
  dragTime.value = seekFromEvent(e);
  const move = (ev: PointerEvent) => { dragTime.value = seekFromEvent(ev); };
  const up = () => stopProgressDrag(true);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
  window.addEventListener("pointercancel", up, { once: true });
  removeDragListeners = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
}

onBeforeUnmount(() => stopProgressDrag(false));

function onVolume(e: Event) {
  player.setVolume(parseFloat((e.target as HTMLInputElement).value));
}

const queueOpen = ref(false);
watch(detailsOpen, (open) => { if (!open) queueOpen.value = false; });
function playFromQueue(i: number) { player.playAt(i); }
function removeFromQueue(i: number) {
  if (i === player.index) return;
  player.queue.splice(i, 1);
  if (i < player.index) player.index--;
}
</script>

<template>
  <footer class="player-bar" :class="{ 'details-open': detailsOpen }">
    <!-- Track info -->
    <div
      class="pb-track"
      :class="{ clickable: player.hasTrack }"
      @click="goNowPlaying"
      @touchstart="onTrackTouchStart"
      @touchend="onTrackTouchEnd"
      @touchcancel="onTrackTouchCancel"
    >
      <div class="pb-cover" :class="{ clickable: player.hasTrack }" :title="player.hasTrack ? expandTitle : ''">
        <img v-if="coverSrc && !coverFailed" :src="coverSrc" alt="" @error="coverFailed = true" />
        <svg v-else viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
        <svg v-if="player.hasTrack" class="pb-cover-ring" viewBox="0 0 48 48" aria-hidden="true">
          <path class="pb-cover-ring-track" d="M24 2H46V46H2V2H24" pathLength="100" />
          <path class="pb-cover-ring-fill" d="M24 2H46V46H2V2H24" pathLength="100" :style="{ strokeDashoffset: 100 - coverProgressPct }" />
        </svg>
      </div>
      <div v-if="player.current" class="pb-meta" :class="{ clickable: player.hasTrack }" :title="expandTitle">
        <div class="pb-title" :title="player.current.title">{{ player.current.title }}</div>
        <div class="pb-artist">{{ player.current.artist || t("player.unknownArtist") }}</div>
      </div>
      <div v-else class="pb-meta">
        <div class="pb-empty">{{ t("player.noTrack") }}</div>
        <div class="pb-empty-sub">{{ t("player.selectSong") }}</div>
      </div>
    </div>

    <!-- Controls + progress -->
    <div class="pb-center">
      <div class="pb-controls">
        <button class="pb-btn pb-fav" :class="{ active: player.starred }" :disabled="!player.hasTrack" :title="player.starred ? t('player.unlike') : t('player.like')" @click="player.toggleStar()">
          <svg v-if="player.starred" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35zm0-2.7C16.76 14.24 20 11.39 20 8.5 20 6.5 18.5 5 16.5 5c-1.54 0-3.04.99-3.57 2.36h-1.87C10.54 5.99 9.04 5 7.5 5 5.5 5 4 6.5 4 8.5c0 2.89 3.24 5.74 8 10.15z"/></svg>
        </button>
        <button class="pb-btn" :disabled="!player.hasTrack" :title="t('player.previous')" @click="player.prev()">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z"/></svg>
        </button>
        <button class="pb-btn pb-play" :disabled="!player.hasTrack" :title="player.playing ? t('player.pause') : t('player.play')" @click="player.toggle()">
          <svg v-if="player.playing" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7L8 5z"/></svg>
        </button>
        <button class="pb-btn" :disabled="!player.hasTrack" :title="t('player.next')" @click="player.next()">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
        </button>
        <button class="pb-btn pb-mode" :class="{ active: player.playMode !== 'sequential' }" :disabled="!player.hasTrack" :title="playModeTitle" @click="player.cyclePlayMode()">
          <svg v-if="player.playMode === 'shuffle'" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17L10.59 9.17zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.92 7.41-1.42 1.42 3.54 3.54L20 14.5V20h-5.5l2.04-2.04-3.12-3.12z"/></svg>
          <svg v-else-if="player.playMode === 'single'" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="9.5" y="15.5" fill="currentColor" font-size="8" font-weight="bold">1</text></svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
        </button>
      </div>
      <div class="pb-progress-row">
        <span class="pb-time">{{ formatDuration(Math.floor(displayTime)) }}</span>
        <div ref="progressEl" class="pb-progress" :class="{ disabled: !player.hasTrack }" @pointerdown="onProgressPointerDown">
          <div
            v-for="(seg, i) in bufferedSegments"
            :key="i"
            class="pb-progress-buffered"
            :style="{ left: seg.left + '%', width: seg.width + '%' }"
          ></div>
          <div class="pb-progress-fill" :style="{ width: progressPct + '%' }"></div>
          <div class="pb-progress-thumb" :class="{ active: dragging }" :style="{ left: progressPct + '%' }">
            <component :is="activeThemeDef?.progressThumb" v-if="activeThemeDef?.progressThumb" />
          </div>
          <div v-if="dragging" class="pb-progress-tooltip" :style="{ left: progressPct + '%' }">{{ fmtPrecise(displayTime) }}</div>
        </div>
        <span class="pb-time">{{ formatDuration(Math.floor(player.duration)) }}</span>
      </div>
    </div>

    <!-- Volume + Queue toggle -->
    <div class="pb-right">
      <input
        class="pb-volume"
        type="range" min="0" max="1" step="0.02"
        :value="player.volume"
        @input="onVolume"
        title="音量"
      />
      <button class="pb-queue-btn" :class="{ active: queueOpen }" @click="queueOpen = !queueOpen" title="播放列表">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 6h13v2H3V6zm0 5h13v2H3v-2zm0 5h9v2H3v-2zm15 0v-6l5 3-5 3z"/></svg>
        <span class="pb-queue-count" v-if="player.queue.length">{{ player.queue.length }}</span>
      </button>
    </div>

    <!-- Queue panel (slides up from player bar) -->
    <transition name="queue-up">
      <div v-if="queueOpen" class="pb-queue-panel">
        <div class="pb-queue-header">
          <span>播放列表 ({{ player.queue.length }})</span>
          <button class="pb-queue-close" @click="queueOpen = false">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="pb-queue-list">
          <div
            v-for="(tr, i) in player.queue"
            :key="tr.id + '-' + i"
            class="pb-queue-item"
            :class="{ playing: i === player.index }"
            @click="playFromQueue(i)"
          >
           <span class="pb-queue-idx">{{ String(i + 1).padStart(2, "0") }}</span>
            <div class="pb-queue-meta">
              <div class="pb-queue-title">{{ tr.title }}</div>
              <div class="pb-queue-artist">{{ tr.artist }}</div>
            </div>
            <span class="pb-queue-dur">{{ formatDuration(Math.floor(tr.duration)) }}</span>
            <button v-if="i !== player.index" class="pb-queue-rm" @click.stop="removeFromQueue(i)">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
          <div v-if="player.queue.length === 0" class="pb-queue-empty">播放列表为空</div>
        </div>
      </div>
    </transition>
  </footer>
</template>

<style scoped>
.player-bar {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  height: var(--player-h);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0 1.25rem;
  background: rgba(10, 10, 11, 0.95);
  backdrop-filter: blur(12px);
  border-top: 1px solid var(--color-border-subtle);
}

/* --- track info --- */
.pb-track { display: flex; align-items: center; gap: 0.8rem; width: 240px; min-width: 0; flex-shrink: 0; }
.pb-cover {
  width: 44px; height: 44px; flex-shrink: 0;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  color: var(--color-text-muted);
}
.pb-cover.clickable, .pb-meta.clickable { cursor: pointer; }
.pb-cover.clickable:hover { border-color: var(--color-accent-dim); }
.pb-meta.clickable:hover .pb-title { color: var(--color-accent-primary); }
.pb-cover img { width: 100%; height: 100%; object-fit: cover; }
.pb-cover-ring {
  display: none;
  position: absolute;
  inset: -4px;
  width: calc(100% + 8px);
  height: calc(100% + 8px);
  overflow: visible;
  pointer-events: none;
}
.pb-cover-ring-track,
.pb-cover-ring-fill {
  fill: none;
  stroke-width: 2;
}
.pb-cover-ring-track { stroke: var(--color-border-subtle); }
.pb-cover-ring-fill {
  stroke: var(--color-accent-primary);
  stroke-dasharray: 100 100;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: stroke-dashoffset 0.15s linear;
}
.pb-meta { min-width: 0; }
.pb-title {
  font-size: var(--fs-md); color: var(--color-text-primary); font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pb-artist {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted);
  letter-spacing: 0.08em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pb-empty {
  font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted);
  letter-spacing: 0.15em; animation: pulse 3s ease-in-out infinite;
}
.pb-empty-sub { font-size: var(--fs-xs); color: var(--color-text-muted); }

/* --- center controls --- */
.pb-center { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 0.15rem; }
.pb-controls { position: relative; display: flex; align-items: center; gap: 0.6rem; }
.pb-btn {
  background: none; border: none;
  color: var(--color-text-secondary);
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: color 0.2s;
  padding: 0;
}
.pb-btn:hover:not(:disabled) { color: var(--color-accent-primary); }
.pb-btn:disabled { color: var(--color-text-muted); opacity: 0.4; cursor: not-allowed; }
.pb-btn.active { color: var(--color-accent-primary); }
/* pb-mode is absolutely positioned (out of flex flow) so it doesn't skew
   the centering of the prev/play/next trio — it sits as an "extra" just past
   the trio's right edge instead of counting toward the row's own width. */
.pb-mode {
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-left: 0.6rem;
}
/* pb-fav mirrors pb-mode on the opposite side, same reasoning. */
.pb-fav {
  position: absolute;
  right: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-right: 0.6rem;
}
.pb-play {
  width: 34px; height: 34px;
  border: 1px solid var(--color-border-strong);
  border-radius: 2px;
  background: var(--color-bg-elevated);
  color: var(--color-accent-primary);
  transition: background-color 0.15s, border-color 0.15s;
}
.pb-play:hover:not(:disabled) {
  background: var(--color-accent-primary);
  color: var(--color-text-inverse);
  border-color: var(--color-accent-primary);
}

.pb-progress-row { display: flex; align-items: center; gap: 0.6rem; width: 100%; max-width: 560px; }
.pb-time {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted);
  width: 40px; text-align: center; flex-shrink: 0;
}
.pb-progress {
  position: relative; flex: 1; height: 14px;
  display: flex; align-items: center; cursor: pointer; touch-action: none;
}
.pb-progress.disabled { cursor: default; }
.pb-progress::before {
  content: ""; position: absolute; left: 0; right: 0;
  height: 3px; background: var(--color-bg-elevated);
}
.pb-progress-fill { position: absolute; left: 0; height: 3px; background: var(--color-accent-primary); }
.pb-progress-buffered {
  position: absolute;
  height: 3px;
  background: var(--color-text-secondary);
  opacity: 0.35;
  pointer-events: none;
}
.pb-progress-thumb {
  position: absolute; width: 9px; height: 9px;
  background: var(--color-accent-primary);
  transform: translateX(-50%) rotate(45deg);
  opacity: 0; transition: opacity 0.15s;
}
.pb-progress:hover .pb-progress-thumb, .pb-progress-thumb.active { opacity: 1; }
.pb-progress-tooltip {
  position: absolute;
  bottom: 16px;
  transform: translateX(-50%);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  padding: 0.2rem 0.4rem;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
}

/* --- right: volume + queue --- */
.pb-right { display: flex; align-items: center; gap: 0.6rem; width: 180px; flex-shrink: 0; justify-content: flex-end; }
.pb-volume { width: 80px; accent-color: var(--color-accent-primary); cursor: pointer; }
.pb-queue-btn {
  position: relative;
  background: none; border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}
.pb-queue-btn:hover, .pb-queue-btn.active { color: var(--color-accent-primary); border-color: var(--color-accent-dim); }
.pb-queue-count {
  position: absolute;
  top: -6px; right: -6px;
  background: var(--color-accent-dim);
  color: var(--color-text-primary);
  border-radius: 8px;
  padding: 0 0.3rem;
  font-size: var(--fs-xs);
  font-family: var(--font-mono);
  min-width: 14px;
  text-align: center;
}

/* --- queue panel --- */
.pb-queue-panel {
  position: absolute;
  bottom: var(--player-h);
  right: 0;
  width: 380px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  box-shadow: 0 -4px 24px rgba(0,0,0,0.3);
  overflow: hidden;
  z-index: 200;
}
.pb-queue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
  font-weight: 500;
}
.pb-queue-close {
  background: none; border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
}
.pb-queue-close:hover { color: var(--color-text-primary); }
.pb-queue-list { overflow-y: auto; flex: 1; }
.pb-queue-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 1rem;
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
}
.pb-queue-item:hover { background: var(--color-bg-tertiary); }
.pb-queue-item.playing { color: var(--color-accent-primary); background: var(--color-bg-tertiary); }
.pb-queue-idx { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); min-width: 24px; }
.pb-queue-item.playing .pb-queue-idx { color: var(--color-accent-primary); }
.pb-queue-meta { flex: 1; min-width: 0; }
.pb-queue-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pb-queue-artist { font-size: var(--fs-xs); color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pb-queue-dur { font-family: var(--font-mono); font-size: var(--fs-xs); flex-shrink: 0; }
.pb-queue-rm {
  background: none; border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  padding: 0;
  border-radius: 50%;
  opacity: 0.5;
}
.pb-queue-rm:hover { opacity: 1; background: var(--color-accent-dim); color: var(--color-text-primary); }
.pb-queue-empty { text-align: center; padding: 2rem; color: var(--color-text-muted); }

/* Transition */
.queue-up-enter-active, .queue-up-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.queue-up-enter-from, .queue-up-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (max-width: 768px) {
  .player-bar { gap: 0.5rem; padding: 0 0.5rem; }
  .pb-track { width: auto; flex: 1; }
  .pb-right { width: auto; gap: 0.3rem; }
  .pb-volume { display: none; }
  .player-bar:not(.details-open) .pb-progress-row { display: none; }
  .pb-center { flex: 0 0 auto; }
  .pb-queue-panel { width: calc(100vw - 1rem); }

  .player-bar:not(.details-open) .pb-center,
  .player-bar.details-open .pb-track { display: none; }
  .player-bar:not(.details-open) .pb-track {
    width: 100%;
    padding-left: 0.35rem;
    padding-right: 3.25rem;
    touch-action: pan-y;
    user-select: none;
  }
  .player-bar:not(.details-open) .pb-cover {
    position: relative;
    overflow: visible;
  }
  .player-bar:not(.details-open) .pb-cover-ring { display: block; }
  .player-bar:not(.details-open) .pb-right,
  .player-bar.details-open .pb-right {
    display: flex;
    position: absolute;
    right: 1.25rem;
    width: auto;
    z-index: 2;
  }
  .player-bar:not(.details-open) .pb-right {
    top: 50%;
    transform: translateY(-50%);
  }
  .player-bar.details-open { justify-content: center; }
  .player-bar.details-open .pb-track { display: none; }
  .player-bar.details-open .pb-center { width: 100%; flex: 1; }
  .player-bar.details-open .pb-progress-row { max-width: none; }
  .player-bar.details-open .pb-right {
    top: 50%;
    transform: translateY(-8px);
  }
}
</style>
