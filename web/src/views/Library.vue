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
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, formatDuration } from "../api";
import { usePlayerStore, type Track } from "../stores/player";

const { t } = useI18n();

const { authFetch, coverArtUrl } = useAuth();
const player = usePlayerStore();

interface Artist { id: string; name: string; albumCount: string; }
interface Album { id: string; name: string; artist: string; year: string; coverArt: string; songCount: string; }

const artists = ref<Artist[]>([]);
const albums = ref<Album[]>([]);
const songs = ref<Track[]>([]);

const currentArtist = ref<Artist | null>(null);
const currentAlbum = ref<Album | null>(null);
const loading = ref(false);
const error = ref("");

async function loadArtists() {
  loading.value = true;
  error.value = "";
  try {
    const xml = await authFetch("getArtists");
    artists.value = parseXmlAttrs(xml, "artist").map((a) => ({
      id: a.id || "", name: a.name || "", albumCount: a.albumCount || "",
    }));
  } catch {
    error.value = t("library.loadFailed");
    artists.value = [];
  }
  loading.value = false;
}

async function openArtist(artist: Artist) {
  currentArtist.value = artist;
  currentAlbum.value = null;
  songs.value = [];
  loading.value = true;
  try {
    const xml = await authFetch("getArtist", { id: artist.id });
    albums.value = parseXmlAttrs(xml, "album").map((a) => ({
      id: a.id || "", name: a.name || a.title || "", artist: a.artist || artist.name,
      year: a.year || "", coverArt: a.coverArt || "", songCount: a.songCount || "",
    }));
  } catch { albums.value = []; }
  loading.value = false;
}

async function openAlbum(album: Album) {
  currentAlbum.value = album;
  loading.value = true;
  try {
    const xml = await authFetch("getAlbum", { id: album.id });
    songs.value = parseXmlAttrs(xml, "song").map((s) => ({
      id: s.id || "",
      title: s.title || "",
      artist: s.artist || album.artist,
      album: s.album || album.name,
      coverArt: s.coverArt || album.coverArt || undefined,
      duration: parseInt(s.duration || "0"),
    }));
  } catch { songs.value = []; }
  loading.value = false;
}

function playSong(i: number) {
  player.setQueue(songs.value, i);
}

function playAlbumFromStart() {
  if (songs.value.length) player.setQueue(songs.value, 0);
}

function backToArtists() {
  currentArtist.value = null;
  currentAlbum.value = null;
  albums.value = [];
  songs.value = [];
}

function backToAlbums() {
  currentAlbum.value = null;
  songs.value = [];
}

onMounted(loadArtists);
</script>

<template>
  <div class="library">
    <div class="page-header">
      <div>
        <div class="mono-label breadcrumb">
          <a @click="backToArtists">{{ t("library.breadcrumb") }}</a>
          <template v-if="currentArtist"> / <a @click="backToAlbums">{{ currentArtist.name }}</a></template>
          <template v-if="currentAlbum"> / <span>{{ currentAlbum.name }}</span></template>
        </div>
        <h1 class="page-title">{{ currentAlbum?.name || currentArtist?.name || t("library.title") }}</h1>
      </div>
      <button v-if="currentAlbum && songs.length" class="btn-primary" @click="playAlbumFromStart">{{ t("library.playAlbum") }}</button>
    </div>

    <div v-if="error" class="status-badge error">{{ error }}</div>
    <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>

    <!-- Level 1: artists -->
    <div v-if="!currentArtist && !loading" class="artist-grid">
      <div v-for="a in artists" :key="a.id" class="card hoverable artist-card" @click="openArtist(a)">
        <div class="artist-glyph">{{ a.name.charAt(0).toUpperCase() || "?" }}</div>
        <div class="artist-name">{{ a.name }}</div>
        <div class="mono-label" v-if="a.albumCount">{{ t("library.albumCount", { n: a.albumCount }) }}</div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <div v-if="!artists.length && !error" class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon">♪</div>
        <div>{{ t("library.noArtists") }}</div>
      </div>
    </div>

    <!-- Level 2: albums of an artist -->
    <div v-else-if="currentArtist && !currentAlbum && !loading" class="album-grid">
      <div v-for="al in albums" :key="al.id" class="card hoverable album-card" @click="openAlbum(al)">
        <div class="album-cover">
          <img v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 300)" :alt="al.name" loading="lazy" />
          <span v-else class="album-cover-placeholder">♪</span>
        </div>
        <div class="album-body">
          <div class="album-name">{{ al.name }}</div>
          <div class="mono-label">{{ al.year || "—" }}<template v-if="al.songCount"> · {{ t("library.trackCount", { n: al.songCount }) }}</template></div>
        </div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <div v-if="!albums.length" class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon">◌</div>
        <div>{{ t("library.noAlbums") }}</div>
      </div>
    </div>

    <!-- Level 3: songs of an album -->
    <div v-else-if="currentAlbum && !loading" class="table-wrap song-table" style="--grid-cols: 36px 1fr auto auto">
      <div class="table-header">
        <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span>
      </div>
      <div
        v-for="(s, i) in songs"
        :key="s.id"
        class="table-row song-row"
        :class="{ playing: player.current?.id === s.id }"
        @click="playSong(i)"
      >
        <span class="song-no">{{ player.current?.id === s.id && player.playing ? "▶" : i + 1 }}</span>
        <span class="song-title">{{ s.title }}</span>
        <span class="song-artist">{{ s.artist }}</span>
        <span class="song-time">{{ formatDuration(s.duration) }}</span>
      </div>
      <div v-if="!songs.length" class="empty-state">{{ t("library.noTracks") }}</div>
    </div>
  </div>
</template>

<style scoped>
.library { max-width: 1200px; }
.breadcrumb { margin-bottom: 0.25rem; }
.breadcrumb a { color: var(--color-text-muted); cursor: pointer; }
.breadcrumb a:hover { color: var(--color-accent-primary); }
.breadcrumb span { color: var(--color-accent-primary); }

/* artists */
.artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 1rem; }
.artist-card { text-align: center; padding: 1.5rem 1rem 1.1rem; }
.artist-glyph {
  width: 56px; height: 56px; margin: 0 auto 0.7rem;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display);
  font-size: 1.6rem;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
}
.artist-name {
  font-weight: 700; font-size: var(--fs-md); color: var(--color-text-primary);
  margin-bottom: 0.2rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* albums */
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 1rem; }
.album-card { padding: 0; overflow: hidden; }
.album-cover {
  aspect-ratio: 1;
  background: var(--color-bg-primary);
  display: flex; align-items: center; justify-content: center;
  border-bottom: 1px solid var(--color-border-subtle);
  overflow: hidden;
}
.album-cover img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.4s ease; }
.album-card:hover .album-cover img { transform: scale(1.05); }
.album-cover-placeholder { font-size: 2rem; color: var(--color-text-muted); }
.album-body { padding: 0.8rem 0.9rem 0.9rem; }
.album-name {
  font-weight: 700; font-size: var(--fs-md); color: var(--color-text-primary);
  margin-bottom: 0.15rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* songs */
.song-row { cursor: pointer; }
.song-row.playing { background: var(--color-accent-dim); }
.song-no { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); text-align: right; }
.song-title { font-size: var(--fs-md); color: var(--color-text-primary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-artist { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-secondary); }
.song-time { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); }
</style>
