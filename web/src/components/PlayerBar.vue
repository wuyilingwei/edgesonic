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

<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "../stores/player";
import { useAuth, formatDuration } from "../api";

const { t } = useI18n();
const player = usePlayerStore();
const { coverArtUrl } = useAuth();

const coverSrc = computed(() => {
  const t = player.current;
  return t?.coverArt ? coverArtUrl(t.coverArt, 80) : "";
});

const progressPct = computed(() =>
  player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0,
);

// 093d — buffered range segments rendered as a light bar behind the
// play-progress fill. Each tuple is [startSec, endSec]; we map to % of
// duration. Browsers usually return one continuous range [0, N] for
// streaming media but may return multiple ranges after seeks.
const bufferedSegments = computed(() => {
  if (player.duration <= 0) return [] as { left: number; width: number }[];
  return player.bufferedRanges.map(([s, e]) => ({
    left: Math.min(Math.max((s / player.duration) * 100, 0), 100),
    width: Math.min(Math.max(((e - s) / player.duration) * 100, 0), 100),
  }));
});

const progressEl = ref<HTMLElement | null>(null);
const dragging = ref(false);

function seekFromEvent(e: MouseEvent) {
  const el = progressEl.value;
  if (!el || player.duration <= 0) return;
  const rect = el.getBoundingClientRect();
  const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  player.seek(ratio * player.duration);
}

function onProgressDown(e: MouseEvent) {
  if (!player.hasTrack) return;
  dragging.value = true;
  seekFromEvent(e);
  const move = (ev: MouseEvent) => seekFromEvent(ev);
  const up = () => {
    dragging.value = false;
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function onVolume(e: Event) {
  player.setVolume(parseFloat((e.target as HTMLInputElement).value));
}
</script>

<template>
  <footer class="player-bar">
    <!-- Track info -->
    <div class="pb-track">
      <div class="pb-cover">
        <img v-if="coverSrc" :src="coverSrc" alt="" />
        <span v-else class="pb-cover-placeholder">♪</span>
      </div>
      <div v-if="player.current" class="pb-meta">
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
        <button class="pb-btn" :disabled="!player.hasTrack" :title="t('player.previous')" @click="player.prev()">⏮</button>
        <button class="pb-btn pb-play" :disabled="!player.hasTrack" :title="player.playing ? t('player.pause') : t('player.play')" @click="player.toggle()">
          {{ player.playing ? "⏸" : "▶" }}
        </button>
        <button class="pb-btn" :disabled="!player.hasTrack" :title="t('player.next')" @click="player.next()">⏭</button>
      </div>
      <div class="pb-progress-row">
        <span class="pb-time">{{ formatDuration(Math.floor(player.currentTime)) }}</span>
        <div ref="progressEl" class="pb-progress" :class="{ disabled: !player.hasTrack }" @mousedown="onProgressDown">
          <!-- 093d — buffered ranges (light bar behind the play fill) -->
          <div
            v-for="(seg, i) in bufferedSegments"
            :key="i"
            class="pb-progress-buffered"
            :style="{ left: seg.left + '%', width: seg.width + '%' }"
          ></div>
          <div class="pb-progress-fill" :style="{ width: progressPct + '%' }"></div>
          <div class="pb-progress-thumb" :class="{ active: dragging }" :style="{ left: progressPct + '%' }"></div>
        </div>
        <span class="pb-time">{{ formatDuration(Math.floor(player.duration)) }}</span>
      </div>
    </div>

    <!-- Volume -->
    <div class="pb-right">
      <span class="pb-vol-icon">{{ player.volume === 0 ? "🔇" : "🔊" }}</span>
      <input
        class="pb-volume"
        type="range" min="0" max="1" step="0.02"
        :value="player.volume"
        @input="onVolume"
      />
    </div>
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
.pb-track { display: flex; align-items: center; gap: 0.8rem; width: 260px; min-width: 0; flex-shrink: 0; }
.pb-cover {
  width: 48px; height: 48px; flex-shrink: 0;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.pb-cover img { width: 100%; height: 100%; object-fit: cover; }
.pb-cover-placeholder { color: var(--color-text-muted); font-size: 1.2rem; }
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
.pb-controls { display: flex; align-items: center; gap: 0.8rem; }
.pb-btn {
  color: var(--color-text-secondary);
  font-size: 0.9rem;
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: color 0.2s;
}
.pb-btn:hover:not(:disabled) { color: var(--color-accent-primary); }
.pb-btn:disabled { color: var(--color-text-muted); opacity: 0.4; cursor: not-allowed; }
.pb-play {
  width: 34px; height: 34px;
  border: 1px solid var(--color-border-strong);
  border-radius: 2px;
  color: var(--color-text-primary);
}
.pb-play:hover:not(:disabled) { background: var(--color-accent-dim); box-shadow: var(--glow); }

.pb-progress-row { display: flex; align-items: center; gap: 0.6rem; width: 100%; max-width: 560px; }
.pb-time {
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted);
  width: 40px; text-align: center; flex-shrink: 0;
}
.pb-progress {
  position: relative; flex: 1; height: 14px;
  display: flex; align-items: center; cursor: pointer;
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

/* --- volume --- */
.pb-right { display: flex; align-items: center; gap: 0.5rem; width: 150px; flex-shrink: 0; justify-content: flex-end; }
.pb-vol-icon { font-size: 0.8rem; opacity: 0.7; }
.pb-volume { width: 90px; accent-color: var(--color-accent-primary); cursor: pointer; }

@media (max-width: 768px) {
  .player-bar { gap: 0.8rem; padding: 0 0.8rem; }
  .pb-track { width: auto; flex: 1; }
  .pb-right, .pb-progress-row { display: none; }
  .pb-center { flex: 0 0 auto; }
}
</style>
