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
import { ref, computed } from "vue";
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
  const volume = ref(parseFloat(localStorage.getItem("edgesonic_volume") || "0.8"));

  const current = computed<Track | null>(() => queue.value[index.value] || null);
  const hasTrack = computed(() => index.value >= 0 && index.value < queue.value.length);

  let elA: HTMLAudioElement | null = null;
  let elB: HTMLAudioElement | null = null;
  let active: HTMLAudioElement | null = null;
  let preloaded: { el: HTMLAudioElement; index: number } | null = null;

  function makeAudio(): HTMLAudioElement {
    const el = new Audio();
    el.preload = "auto";
    el.volume = volume.value;
    el.addEventListener("timeupdate", () => { if (el === active) currentTime.value = el.currentTime; });
    el.addEventListener("durationchange", () => {
      if (el === active && isFinite(el.duration)) duration.value = el.duration;
    });
    el.addEventListener("play", () => { if (el === active) playing.value = true; });
    el.addEventListener("pause", () => { if (el === active) playing.value = false; });
    el.addEventListener("ended", () => { if (el === active) next(); });
    el.addEventListener("error", () => { if (el === active) playing.value = false; });
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
    el.src = streamUrl(queue.value[ni].id);
    el.load();
    preloaded = { el, index: ni };
  }

  function loadCurrent(autoplay = true) {
    const track = current.value;
    if (!track) return;
    ensureElements();
    currentTime.value = 0;
    duration.value = track.duration || 0;

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
    if (autoplay) void active!.play().catch(() => { playing.value = false; });
  }

  /** Replace queue and start playing at startIndex. */
  function setQueue(tracks: Track[], startIndex = 0) {
    invalidatePreload();
    queue.value = tracks;
    index.value = tracks.length ? Math.min(Math.max(startIndex, 0), tracks.length - 1) : -1;
    loadCurrent();
  }

  function playAt(i: number) {
    if (i < 0 || i >= queue.value.length) return;
    index.value = i;
    loadCurrent();
  }

  function toggle() {
    if (!hasTrack.value || !active) return;
    if (active.paused) void active.play().catch(() => { playing.value = false; });
    else active.pause();
  }

  function next() {
    if (index.value < queue.value.length - 1) playAt(index.value + 1);
    else playing.value = false;
  }

  function prev() {
    if (!active) return;
    // Restart current track if more than 3s in, like most players.
    if (active.currentTime > 3) { active.currentTime = 0; return; }
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
    localStorage.setItem("edgesonic_volume", String(volume.value));
  }

  /** Stop playback and clear queue (e.g. on logout). */
  function clear() {
    invalidatePreload();
    for (const el of [elA, elB]) {
      if (el) { el.pause(); el.removeAttribute("src"); el.load(); }
    }
    queue.value = [];
    index.value = -1;
    playing.value = false;
    currentTime.value = 0;
    duration.value = 0;
  }

  return {
    queue, index, playing, currentTime, duration, volume,
    current, hasTrack,
    setQueue, playAt, toggle, next, prev, seek, setVolume, clear,
  };
});
