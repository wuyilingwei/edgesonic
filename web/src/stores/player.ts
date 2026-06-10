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
 * Player store — owns the <audio> element and the play queue.
 * Stream URLs are freshly signed per track (t = md5(sessionToken + salt)).
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

  let audio: HTMLAudioElement | null = null;

  function ensureAudio(): HTMLAudioElement {
    if (!audio) {
      audio = new Audio();
      audio.volume = volume.value;
      audio.addEventListener("timeupdate", () => { currentTime.value = audio!.currentTime; });
      audio.addEventListener("durationchange", () => {
        if (isFinite(audio!.duration)) duration.value = audio!.duration;
      });
      audio.addEventListener("play", () => { playing.value = true; });
      audio.addEventListener("pause", () => { playing.value = false; });
      audio.addEventListener("ended", () => { next(); });
      audio.addEventListener("error", () => { playing.value = false; });
    }
    return audio;
  }

  function loadCurrent(autoplay = true) {
    const track = current.value;
    if (!track) return;
    const { streamUrl } = useAuth();
    const el = ensureAudio();
    currentTime.value = 0;
    duration.value = track.duration || 0;
    el.src = streamUrl(track.id);
    if (autoplay) void el.play().catch(() => { playing.value = false; });
  }

  /** Replace queue and start playing at startIndex. */
  function setQueue(tracks: Track[], startIndex = 0) {
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
    if (!hasTrack.value) return;
    const el = ensureAudio();
    if (el.paused) void el.play().catch(() => { playing.value = false; });
    else el.pause();
  }

  function next() {
    if (index.value < queue.value.length - 1) playAt(index.value + 1);
    else playing.value = false;
  }

  function prev() {
    const el = ensureAudio();
    // Restart current track if more than 3s in, like most players.
    if (el.currentTime > 3) { el.currentTime = 0; return; }
    if (index.value > 0) playAt(index.value - 1);
    else el.currentTime = 0;
  }

  function seek(seconds: number) {
    if (!hasTrack.value) return;
    const el = ensureAudio();
    el.currentTime = Math.min(Math.max(seconds, 0), duration.value || 0);
    currentTime.value = el.currentTime;
  }

  function setVolume(v: number) {
    volume.value = Math.min(Math.max(v, 0), 1);
    ensureAudio().volume = volume.value;
    localStorage.setItem("edgesonic_volume", String(volume.value));
  }

  /** Stop playback and clear queue (e.g. on logout). */
  function clear() {
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
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
