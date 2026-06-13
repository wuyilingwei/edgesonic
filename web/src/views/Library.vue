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
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, formatDuration } from "../api";
import { usePlayerStore, type Track } from "../stores/player";
import TagEditor from "../components/TagEditor.vue";
import ScrapeButton from "../components/ScrapeButton.vue";
import type { ScrapeResult } from "../lib/scrape";

const { t } = useI18n();

const { authFetch, writeTags, batchWriteTags, coverArtUrl, isAdmin } = useAuth();
const player = usePlayerStore();
const BATCH_MAX = 50;

interface Artist { id: string; name: string; albumCount: string; }
interface Album { id: string; name: string; artist: string; year: string; coverArt: string; songCount: string; }

type Tab = "artists" | "albums" | "songs";
const savedTab = localStorage.getItem("edgesonic_library_tab") as Tab | null;
const tab = ref<Tab>(savedTab === "artists" || savedTab === "albums" || savedTab === "songs" ? savedTab : "songs");

const artists = ref<Artist[]>([]);
const albums = ref<Album[]>([]);
const songs = ref<Track[]>([]);

const currentArtist = ref<Artist | null>(null);
const currentAlbum = ref<Album | null>(null);
const loading = ref(false);
const error = ref("");

// === Albums tab (paged grid over the whole library) ===
const ALBUM_PAGE = 48;
const allAlbums = ref<Album[]>([]);
const albumOffset = ref(0);
const albumsDone = ref(false);

// === Songs tab (paged flat list over the whole library) ===
const SONG_PAGE = 500;
const allSongs = ref<Track[]>([]);
const songOffset = ref(0);
const songsDone = ref(false);

function switchTab(next: Tab) {
  tab.value = next;
  localStorage.setItem("edgesonic_library_tab", next);
  currentArtist.value = null;
  currentAlbum.value = null;
  albums.value = [];
  songs.value = [];
  error.value = "";
  if (next === "artists" && !artists.value.length) loadArtists();
  if (next === "albums" && !allAlbums.value.length) loadMoreAlbums();
  if (next === "songs" && !allSongs.value.length) loadMoreSongs();
}

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

async function loadMoreAlbums() {
  loading.value = true;
  try {
    const xml = await authFetch("getAlbumList2", {
      type: "alphabeticalByName", size: String(ALBUM_PAGE), offset: String(albumOffset.value),
    });
    const page = parseXmlAttrs(xml, "album").map((a) => ({
      id: a.id || "", name: a.name || "", artist: a.artist || "",
      year: a.year || "", coverArt: a.coverArt || "", songCount: a.songCount || "",
    }));
    allAlbums.value.push(...page);
    albumOffset.value += page.length;
    if (page.length < ALBUM_PAGE) albumsDone.value = true;
  } catch { error.value = t("library.loadFailed"); }
  loading.value = false;
}

async function loadMoreSongs() {
  loading.value = true;
  try {
    const xml = await authFetch("search3", {
      query: "", artistCount: "0", albumCount: "0",
      songCount: String(SONG_PAGE), songOffset: String(songOffset.value),
    });
    const page = parseXmlAttrs(xml, "song").map((s) => ({
      id: s.id || "",
      title: s.title || "",
      artist: s.artist || "",
      album: s.album || "",
      coverArt: s.coverArt || undefined,
      duration: parseInt(s.duration || "0"),
    }));
    allSongs.value.push(...page);
    songOffset.value += page.length;
    if (page.length < SONG_PAGE) songsDone.value = true;
  } catch { error.value = t("library.loadFailed"); }
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

function playFromAll(i: number) {
  player.setQueue(allSongs.value, i);
}

function playAlbumFromStart() {
  if (songs.value.length) player.setQueue(songs.value, 0);
}

// === Tag editor (single + batch) ===
// editTargets: array drives both modes; length 1 → single, length >1 → batch.
const editTargets = ref<Track[]>([]);
const editInitial = ref<Record<string, string | number>>({});
const editBusy = ref(false);
const editMsg = ref("");
const editErr = ref(false);
const editorOpen = ref(false);
const editorMode = computed<"single" | "batch">(() => editTargets.value.length > 1 ? "batch" : "single");

async function openEditor(s: Track) {
  editTargets.value = [s];
  editMsg.value = ""; editErr.value = false;
  // seed with the list-row data, then enrich from getSong for genre/year/track
  editInitial.value = { title: s.title, artist: s.artist, album: s.album };
  editorOpen.value = true;
  try {
    const xml = await authFetch("getSong", { id: s.id });
    const full = parseXmlAttrs(xml, "song")[0];
    if (full && editTargets.value[0]?.id === s.id) {
      editInitial.value = {
        title: full.title || s.title,
        artist: full.artist || s.artist,
        album: full.album || s.album,
        albumArtist: full.albumArtist || "",
        genre: full.genre || "",
        year: full.year || "",
        track: full.track || "",
        disc: full.discNumber || "",
      };
    }
  } catch { /* prefill stays partial */ }
}

function openBatchEditor() {
  if (!selectedIds.value.length) return;
  const lookup = new Map(allSongs.value.map((s) => [s.id, s]));
  editTargets.value = selectedIds.value.map((id) => lookup.get(id)).filter(Boolean) as Track[];
  editInitial.value = {};
  editMsg.value = ""; editErr.value = false;
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
  // keep targets briefly so the modal slide-out reads consistent state; reset on next open.
}

// === 040 scrape-button helpers ===
// Build a "title artist" query from the live TagEditor form; falls back to the
// initial track data when the user hasn't typed anything yet.
function scrapeQueryFromForm(form: Record<string, string>): string {
  const t1 = (form.title || "").trim();
  const a1 = (form.artist || "").trim();
  if (t1 || a1) return [t1, a1].filter(Boolean).join(" ");
  const init = editInitial.value;
  return [init.title, init.artist].filter(Boolean).join(" ");
}

// Merge a ScrapeResult into TagEditor's reactive form + apply flags. Only
// fields the result actually carries get touched; unchecked-apply boxes (batch
// mode) are NOT auto-flipped — single mode infers "changed" from initialTags.
function applyScrapeResult(
  form: Record<string, string>,
  applyFlags: Record<string, boolean>,
  r: ScrapeResult,
) {
  if (r.title) form.title = r.title;
  if (r.artist) form.artist = r.artist;
  if (r.album) form.album = r.album;
  if (r.year) form.year = String(r.year);
  // Touch the apply flags for batch mode UX parity (no-op in single mode).
  if (r.title) applyFlags.title = true;
  if (r.artist) applyFlags.artist = true;
  if (r.album) applyFlags.album = true;
  if (r.year) applyFlags.year = true;
}

async function onEditorSubmit(patch: Record<string, string | number>, cover?: { data: string; mime: string }) {
  if (!editTargets.value.length || (!Object.keys(patch).length && !cover)) return;
  editBusy.value = true; editMsg.value = ""; editErr.value = false;

  try {
    if (editorMode.value === "single") {
      const target = editTargets.value[0];
      const res = await writeTags(target.id, patch, cover);
      if (!res.ok) {
        editErr.value = true;
        editMsg.value = res.error || t("library.editFailed");
      } else {
        // reflect changes in the open list without a full reload
        if (typeof patch.title === "string") target.title = patch.title;
        if (typeof patch.artist === "string") target.artist = patch.artist;
        if (typeof patch.album === "string") target.album = patch.album;
        const files = res.files || [];
        const written = files.filter((x) => x.written).length;
        const skipped = files.filter((x) => !x.written).map((x) => x.reason).filter(Boolean);
        editMsg.value = t("library.editSaved", { written, total: files.length })
          + (skipped.length ? ` (${skipped.join("; ")})` : "");
      }
    } else {
      const ids = editTargets.value.map((t) => t.id);
      const res = await batchWriteTags(ids, patch, cover);
      if (!res.ok) {
        editErr.value = true;
        editMsg.value = res.error || t("tagEditor.batchFailed");
      } else {
        editMsg.value = t("tagEditor.batchSaved", { succeeded: res.succeeded ?? 0, failed: res.failed ?? 0 });
        // optimistic local update for batched fields
        for (const target of editTargets.value) {
          if (typeof patch.title === "string") target.title = patch.title;
          if (typeof patch.artist === "string") target.artist = patch.artist;
          if (typeof patch.album === "string") target.album = patch.album;
        }
        selectedIds.value = [];
      }
    }
  } catch {
    editErr.value = true;
    editMsg.value = editorMode.value === "batch" ? t("tagEditor.batchFailed") : t("library.editFailed");
  }
  editBusy.value = false;
}

// === Batch selection (songs tab only) ===
const selectedIds = ref<string[]>([]);
const selectedSet = computed(() => new Set(selectedIds.value));

function toggleSelected(id: string) {
  const idx = selectedIds.value.indexOf(id);
  if (idx >= 0) selectedIds.value.splice(idx, 1);
  else selectedIds.value.push(id);
}
function clearSelection() { selectedIds.value = []; }

function backToList() {
  currentArtist.value = null;
  currentAlbum.value = null;
  albums.value = [];
  songs.value = [];
}

function backToAlbums() {
  currentAlbum.value = null;
  songs.value = [];
}

onMounted(() => {
  if (tab.value === "artists") loadArtists();
  else if (tab.value === "albums") loadMoreAlbums();
  else loadMoreSongs();
});

// ============================================================================
// 061 — Share creation (song / album). Inline modal, no router push.
//
// Backend: GET /rest/createShare?id=<song|album>&description=&expires=<ms>
// Returns: <shares><share id url description ...><entry .../></share></shares>
//
// We deliberately do NOT touch any of the rendering / playback / batch-edit
// state above — 061's footprint is strictly additive (this block + a couple
// of buttons in the template + a modal at the bottom).
// ============================================================================
const shareOpen = ref(false);
const shareTarget = ref<{ kind: "song" | "album"; id: string; label: string } | null>(null);
const shareDescription = ref("");
const shareExpiresType = ref<"never" | "days" | "datetime">("never");
const shareExpiresDays = ref(7);
const shareExpiresAt = ref("");
const shareBusy = ref(false);
const shareError = ref("");
const shareCreatedUrl = ref("");

function openShare(kind: "song" | "album", id: string, label: string) {
  shareTarget.value = { kind, id, label };
  shareDescription.value = "";
  shareExpiresType.value = "never";
  shareExpiresDays.value = 7;
  shareExpiresAt.value = "";
  shareError.value = "";
  shareCreatedUrl.value = "";
  shareOpen.value = true;
}
function closeShare() {
  shareOpen.value = false;
  shareTarget.value = null;
  shareCreatedUrl.value = "";
}
function shareFailed(xml: string): boolean { return /status="failed"/.test(xml); }
function shareExtractError(xml: string): string | null {
  const m = /<error[^>]+message="([^"]+)"/.exec(xml);
  return m ? m[1] : null;
}
function shareExtractUrl(xml: string): string {
  // <share id="..." url="https://host/share/xx" .../>
  const m = /<share\s+[^>]*\burl="([^"]+)"/.exec(xml);
  return m ? m[1].replace(/&amp;/g, "&") : "";
}
async function submitShare() {
  if (!shareTarget.value) return;
  shareBusy.value = true;
  shareError.value = "";
  shareCreatedUrl.value = "";
  try {
    const params: Record<string, string> = { id: shareTarget.value.id };
    const desc = shareDescription.value.trim();
    if (desc) params.description = desc;
    if (shareExpiresType.value === "days") {
      const d = Number(shareExpiresDays.value);
      if (Number.isFinite(d) && d > 0) {
        params.expires = String(Date.now() + Math.floor(d * 86400000));
      }
    } else if (shareExpiresType.value === "datetime" && shareExpiresAt.value) {
      const ts = Date.parse(shareExpiresAt.value);
      if (Number.isFinite(ts) && ts > Date.now()) params.expires = String(ts);
    }
    const xml = await authFetch("createShare", params);
    if (shareFailed(xml)) {
      shareError.value = shareExtractError(xml) || t("library.shareCreateFailed");
    } else {
      shareCreatedUrl.value = shareExtractUrl(xml);
    }
  } catch {
    shareError.value = t("library.shareCreateFailed");
  }
  shareBusy.value = false;
}
async function copyShareUrl() {
  if (!shareCreatedUrl.value) return;
  try { await navigator.clipboard.writeText(shareCreatedUrl.value); } catch { /* silent */ }
}

// ============================================================================
// 069 — Add-to-Playlist affordance.
//
// Per-song button sits to the left of the 061 share-btn (also absolute, so the
// existing --grid-cols template is untouched). Clicking opens a small modal
// listing the caller's playlists; picking one calls updatePlaylist with
// songIdToAdd. A "Create new playlist..." sentinel option creates the playlist
// on the fly (createPlaylist with the seed song), avoiding a forced detour
// through /playlists for first-time users.
// ============================================================================
interface AddPlaylistRow {
  id: string;
  name: string;
  songCount: string;
}
const addPlaylistOpen = ref(false);
const addPlaylistTarget = ref<{ id: string; title: string } | null>(null);
const addPlaylistList = ref<AddPlaylistRow[]>([]);
const addPlaylistLoading = ref(false);
const addPlaylistBusy = ref(false);
const addPlaylistMessage = ref("");
const addPlaylistError = ref("");
const addPlaylistCreating = ref(false);
const addPlaylistNewName = ref("");

async function openAddToPlaylist(songId: string, title: string) {
  addPlaylistTarget.value = { id: songId, title };
  addPlaylistOpen.value = true;
  addPlaylistMessage.value = "";
  addPlaylistError.value = "";
  addPlaylistCreating.value = false;
  addPlaylistNewName.value = "";
  addPlaylistLoading.value = true;
  try {
    const xml = await authFetch("getPlaylists");
    addPlaylistList.value = parseXmlAttrs(xml, "playlist").map((p) => ({
      id: p.id || "",
      name: p.name || "",
      songCount: p.songCount || "0",
    }));
  } catch {
    addPlaylistList.value = [];
  } finally {
    addPlaylistLoading.value = false;
  }
}
function closeAddToPlaylist() {
  addPlaylistOpen.value = false;
  addPlaylistTarget.value = null;
  addPlaylistMessage.value = "";
  addPlaylistError.value = "";
  addPlaylistCreating.value = false;
}
async function addSongToPlaylist(playlistId: string) {
  if (!addPlaylistTarget.value) return;
  addPlaylistBusy.value = true;
  addPlaylistError.value = "";
  addPlaylistMessage.value = "";
  try {
    const xml = await authFetch("updatePlaylist", {
      playlistId,
      songIdToAdd: addPlaylistTarget.value.id,
    });
    if (/status="failed"/.test(xml)) {
      const m = /<error[^>]+message="([^"]+)"/.exec(xml);
      throw new Error(m?.[1] || "add failed");
    }
    addPlaylistMessage.value = t("library.addedToPlaylist");
    // Brief delay so the user sees the confirmation, then auto-close.
    setTimeout(() => { if (addPlaylistOpen.value) closeAddToPlaylist(); }, 900);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addPlaylistError.value = `${t("library.addToPlaylistFailed")}: ${msg}`;
  } finally {
    addPlaylistBusy.value = false;
  }
}
function beginCreateNew() {
  addPlaylistCreating.value = true;
  addPlaylistNewName.value = "";
  addPlaylistError.value = "";
}
async function submitCreateAndAdd() {
  if (!addPlaylistTarget.value) return;
  const name = addPlaylistNewName.value.trim();
  if (!name) {
    addPlaylistError.value = t("library.addToPlaylistFailed");
    return;
  }
  addPlaylistBusy.value = true;
  addPlaylistError.value = "";
  try {
    const xml = await authFetch("createPlaylist", {
      name,
      songId: addPlaylistTarget.value.id,
    });
    if (/status="failed"/.test(xml)) {
      const m = /<error[^>]+message="([^"]+)"/.exec(xml);
      throw new Error(m?.[1] || "create failed");
    }
    addPlaylistMessage.value = t("library.addedToPlaylist");
    setTimeout(() => { if (addPlaylistOpen.value) closeAddToPlaylist(); }, 900);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addPlaylistError.value = `${t("library.addToPlaylistFailed")}: ${msg}`;
  } finally {
    addPlaylistBusy.value = false;
  }
}
</script>

<template>
  <div class="library">
    <div class="page-header">
      <div>
        <div class="mono-label breadcrumb">
          <a @click="backToList">{{ t("library.breadcrumb") }}</a>
          <template v-if="currentArtist"> / <a @click="backToAlbums">{{ currentArtist.name }}</a></template>
          <template v-if="currentAlbum"> / <span>{{ currentAlbum.name }}</span></template>
        </div>
        <h1 class="page-title">{{ currentAlbum?.name || currentArtist?.name || t("library.title") }}</h1>
      </div>
      <button v-if="currentAlbum && songs.length" class="btn-primary" @click="playAlbumFromStart">{{ t("library.playAlbum") }}</button>
    </div>

    <!-- View tabs (hidden while drilled into an artist/album) -->
    <div v-if="!currentArtist && !currentAlbum" class="view-tabs">
      <button :class="['view-tab', { active: tab === 'songs' }]" @click="switchTab('songs')">{{ t("library.tabSongs") }}</button>
      <button :class="['view-tab', { active: tab === 'albums' }]" @click="switchTab('albums')">{{ t("library.tabAlbums") }}</button>
      <button :class="['view-tab', { active: tab === 'artists' }]" @click="switchTab('artists')">{{ t("library.tabArtists") }}</button>
    </div>

    <div v-if="error" class="status-badge error">{{ error }}</div>

    <!-- Drill-down: songs of an album (any tab) -->
    <div v-if="currentAlbum" class="table-wrap song-table" :style="`--grid-cols: 36px 1fr auto auto${isAdmin ? ' 32px' : ''}`">
      <div class="table-header">
        <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span v-if="isAdmin"></span>
      </div>
      <!-- 061: album-level share affordance, sits above the track table. -->
      <button v-if="currentAlbum" class="album-share-btn" :title="t('library.share')" @click.stop="openShare('album', currentAlbum.id, currentAlbum.name)">⤴ {{ t("library.share") }}</button>
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
        <button v-if="isAdmin" class="edit-btn" :title="t('library.editSong')" @click.stop="openEditor(s)">✎</button>
        <!-- 061: per-song share, absolute-positioned so we don't touch grid-cols. -->
        <button class="share-btn" :title="t('library.share')" @click.stop="openShare('song', s.id, s.title)">⤴</button>
        <!-- 069: per-song add-to-playlist, also absolute (right: 3.6rem leaves room for share-btn). -->
        <button class="add-playlist-btn" :title="t('library.addToPlaylist')" @click.stop="openAddToPlaylist(s.id, s.title)">＋</button>
      </div>
      <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>
      <div v-else-if="!songs.length" class="empty-state">{{ t("library.noTracks") }}</div>
    </div>

    <!-- Drill-down: albums of an artist -->
    <div v-else-if="currentArtist" class="album-grid">
      <div v-for="al in albums" :key="al.id" class="card hoverable album-card" @click="openAlbum(al)">
        <div class="album-cover">
          <img v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 300)" :alt="al.name" loading="lazy" />
          <span v-else class="album-cover-placeholder">♪</span>
        </div>
        <div class="album-body">
          <div class="album-name">{{ al.name }}</div>
          <div class="mono-label">{{ al.year || "—" }}<template v-if="al.songCount"> · {{ t("library.trackCount", { n: al.songCount }) }}</template></div>
        </div>
        <!-- 061: per-album share. -->
        <button class="card-share-btn" :title="t('library.share')" @click.stop="openShare('album', al.id, al.name)">⤴</button>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <div v-if="loading" class="empty-state" style="grid-column: 1/-1">{{ t("common.loading") }}</div>
      <div v-else-if="!albums.length" class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon">◌</div>
        <div>{{ t("library.noAlbums") }}</div>
      </div>
    </div>

    <!-- Tab: artists -->
    <div v-else-if="tab === 'artists'" class="artist-grid">
      <div v-for="a in artists" :key="a.id" class="card hoverable artist-card" @click="openArtist(a)">
        <div class="artist-glyph">{{ a.name.charAt(0).toUpperCase() || "?" }}</div>
        <div class="artist-name">{{ a.name }}</div>
        <div class="mono-label" v-if="a.albumCount">{{ t("library.albumCount", { n: a.albumCount }) }}</div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <div v-if="loading" class="empty-state" style="grid-column: 1/-1">{{ t("common.loading") }}</div>
      <div v-else-if="!artists.length && !error" class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon">♪</div>
        <div>{{ t("library.noArtists") }}</div>
      </div>
    </div>

    <!-- Tab: all albums -->
    <div v-else-if="tab === 'albums'">
      <div class="album-grid">
        <div v-for="al in allAlbums" :key="al.id" class="card hoverable album-card" @click="openAlbum(al)">
          <div class="album-cover">
            <img v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 300)" :alt="al.name" loading="lazy" />
            <span v-else class="album-cover-placeholder">♪</span>
          </div>
          <div class="album-body">
            <div class="album-name">{{ al.name }}</div>
            <div class="mono-label">{{ al.artist || "—" }}<template v-if="al.songCount"> · {{ t("library.trackCount", { n: al.songCount }) }}</template></div>
          </div>
          <!-- 061: per-album share. -->
          <button class="card-share-btn" :title="t('library.share')" @click.stop="openShare('album', al.id, al.name)">⤴</button>
          <div class="corner corner-tr"></div>
          <div class="corner corner-bl"></div>
        </div>
        <div v-if="!allAlbums.length && !loading" class="empty-state" style="grid-column: 1/-1">
          <div class="empty-state-icon">◌</div>
          <div>{{ t("library.noAlbums") }}</div>
        </div>
      </div>
      <div class="load-more">
        <span v-if="loading" class="mono-label">{{ t("common.loading") }}</span>
        <button v-else-if="!albumsDone" class="btn-secondary" @click="loadMoreAlbums">{{ t("library.loadMore") }}</button>
      </div>
    </div>

    <!-- Tab: all songs -->
    <div v-else-if="tab === 'songs'">
      <!-- Batch selection toolbar (admin-only) -->
      <div v-if="isAdmin && selectedIds.length" class="batch-toolbar">
        <span class="mono-label">{{ t("library.selected", { n: selectedIds.length }) }}</span>
        <button class="btn-secondary btn-sm" @click="clearSelection">{{ t("library.clearSelection") }}</button>
        <button
          class="btn-primary btn-sm"
          :disabled="selectedIds.length > BATCH_MAX"
          :title="selectedIds.length > BATCH_MAX ? t('library.batchTooMany') : ''"
          @click="openBatchEditor"
        >{{ t("library.batchEdit") }}</button>
      </div>
      <div class="table-wrap song-table" :style="`--grid-cols: ${isAdmin ? '24px ' : ''}36px 1fr 1fr auto auto${isAdmin ? ' 32px' : ''}`">
        <div class="table-header">
          <span v-if="isAdmin"></span>
          <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colAlbum") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span v-if="isAdmin"></span>
        </div>
        <div
          v-for="(s, i) in allSongs"
          :key="s.id"
          class="table-row song-row"
          :class="{ playing: player.current?.id === s.id, selected: selectedSet.has(s.id) }"
          @click="playFromAll(i)"
        >
          <input
            v-if="isAdmin"
            type="checkbox"
            class="row-check"
            :checked="selectedSet.has(s.id)"
            :title="t('library.select')"
            @click.stop="toggleSelected(s.id)"
          />
          <span class="song-no">{{ player.current?.id === s.id && player.playing ? "▶" : i + 1 }}</span>
          <span class="song-title">{{ s.title }}</span>
          <span class="song-album">{{ s.album }}</span>
          <span class="song-artist">{{ s.artist }}</span>
          <span class="song-time">{{ formatDuration(s.duration) }}</span>
          <button v-if="isAdmin" class="edit-btn" :title="t('library.editSong')" @click.stop="openEditor(s)">✎</button>
          <!-- 061: per-song share. -->
          <button class="share-btn" :title="t('library.share')" @click.stop="openShare('song', s.id, s.title)">⤴</button>
          <!-- 069: per-song add-to-playlist. -->
          <button class="add-playlist-btn" :title="t('library.addToPlaylist')" @click.stop="openAddToPlaylist(s.id, s.title)">＋</button>
        </div>
        <div v-if="!allSongs.length && !loading" class="empty-state">{{ t("library.noTracks") }}</div>
      </div>
      <div class="load-more">
        <span v-if="loading" class="mono-label">{{ t("common.loading") }}</span>
        <button v-else-if="!songsDone" class="btn-secondary" @click="loadMoreSongs">{{ t("library.loadMore") }}</button>
      </div>
    </div>
    <!-- Tag editor (single + batch) -->
    <TagEditor
      :open="editorOpen"
      :mode="editorMode"
      :song-ids="editTargets.map((t) => t.id)"
      :initial-tags="editInitial"
      :busy="editBusy"
      :message="editMsg"
      :error="editErr"
      @submit="onEditorSubmit"
      @close="closeEditor"
    >
      <!-- 040: scrape button in extras slot. Single-mode only; batch UX has no
           obvious "one master query" so we hide the button there. -->
      <template v-if="editorMode === 'single'" #extras="{ form, apply }">
        <ScrapeButton
          :initial-query="scrapeQueryFromForm(form)"
          :song-master-id="editTargets[0]?.id || ''"
          @apply="(r: ScrapeResult) => applyScrapeResult(form, apply, r)"
        />
      </template>
    </TagEditor>

    <!-- 061: Share modal. Lightweight standalone (no extra component) — opens
         on row/card share button click; on success, shows the public URL with
         a copy button. -->
    <div v-if="shareOpen" class="modal-backdrop" @click.self="closeShare">
      <div class="modal share-modal">
        <div class="modal-title">{{ t("library.share") }} — {{ shareTarget?.label }}</div>
        <div v-if="!shareCreatedUrl" style="display:flex; flex-direction:column; gap:0.7rem">
          <div class="form-group">
            <label class="form-label">{{ t("shares.description") }} <span class="optional">({{ t("shares.optional") }})</span></label>
            <input v-model="shareDescription" class="form-input" :placeholder="t('shares.descriptionPlaceholder')" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("shares.expires") }}</label>
            <div class="seg-row">
              <button type="button" :class="['seg-btn', { active: shareExpiresType === 'never' }]" @click="shareExpiresType = 'never'">{{ t("shares.expiresNever") }}</button>
              <button type="button" :class="['seg-btn', { active: shareExpiresType === 'days' }]" @click="shareExpiresType = 'days'">{{ t("shares.expiresIn") }}</button>
              <button type="button" :class="['seg-btn', { active: shareExpiresType === 'datetime' }]" @click="shareExpiresType = 'datetime'">{{ t("shares.expiresAt") }}</button>
            </div>
            <div v-if="shareExpiresType === 'days'" style="margin-top:0.5rem; display:flex; align-items:center; gap:0.5rem">
              <input v-model.number="shareExpiresDays" type="number" min="1" max="3650" class="form-input" style="max-width:100px" />
              <span class="mono-label">{{ t("shares.days") }}</span>
            </div>
            <input v-if="shareExpiresType === 'datetime'" v-model="shareExpiresAt" type="datetime-local" class="form-input" style="margin-top:0.5rem" />
          </div>
          <div v-if="shareError" class="status-badge error">{{ shareError }}</div>
        </div>
        <div v-else class="share-created">
          <div class="mono-label">{{ t("shares.publicUrl") }}:</div>
          <div class="share-url-box">{{ shareCreatedUrl }}</div>
          <button class="btn-secondary btn-sm" @click="copyShareUrl">{{ t("shares.copyUrl") }}</button>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeShare">{{ shareCreatedUrl ? t("common.close") : t("shares.cancel") }}</button>
          <button v-if="!shareCreatedUrl" class="btn-primary" :disabled="shareBusy" @click="submitShare">
            {{ shareBusy ? t("common.loading") : t("shares.save") }}
          </button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- 069: Add-to-playlist modal. Singleton at root, mirrors the share-modal
         pattern — opens on the per-song [＋] button. Lists existing playlists
         and exposes a "create new" sentinel that round-trips through
         createPlaylist with the seed song. -->
    <div v-if="addPlaylistOpen" class="modal-backdrop" @click.self="closeAddToPlaylist">
      <div class="modal add-playlist-modal">
        <div class="modal-title">{{ t("library.addToPlaylist") }} — {{ addPlaylistTarget?.title }}</div>

        <div v-if="addPlaylistLoading" class="empty-state" style="padding: 1rem">
          {{ t("common.loading") }}
        </div>

        <div v-else-if="addPlaylistCreating" class="form-group" style="margin-top: 0.6rem">
          <label class="form-label">{{ t("playlists.name") }}</label>
          <input v-model="addPlaylistNewName" class="form-input" autofocus :placeholder="t('playlists.namePlaceholder')" />
        </div>

        <template v-else>
          <div v-if="!addPlaylistList.length" class="empty-state" style="padding: 1rem">
            {{ t("library.noPlaylists") }}
          </div>
          <div v-else class="add-playlist-list">
            <div
              v-for="p in addPlaylistList"
              :key="p.id"
              class="add-playlist-row"
              @click="addSongToPlaylist(p.id)"
            >
              <span class="add-playlist-name">{{ p.name }}</span>
              <span class="mono-label">{{ p.songCount }} ♪</span>
            </div>
          </div>
          <button class="create-new-row" @click="beginCreateNew">{{ t("library.createNewPlaylist") }}</button>
        </template>

        <div v-if="addPlaylistMessage" class="status-badge info" style="margin-top: 0.6rem">{{ addPlaylistMessage }}</div>
        <div v-if="addPlaylistError" class="status-badge error" style="margin-top: 0.6rem">{{ addPlaylistError }}</div>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeAddToPlaylist">{{ t("playlists.cancel") }}</button>
          <button
            v-if="addPlaylistCreating"
            class="btn-primary"
            :disabled="addPlaylistBusy"
            @click="submitCreateAndAdd"
          >{{ addPlaylistBusy ? t("common.loading") : t("playlists.save") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.library { max-width: 1200px; }
.breadcrumb { margin-bottom: 0.25rem; }
.breadcrumb a { color: var(--color-text-muted); cursor: pointer; }
.breadcrumb a:hover { color: var(--color-accent-primary); }
.breadcrumb span { color: var(--color-accent-primary); }

/* view tabs */
.view-tabs {
  display: flex; gap: 0;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--color-border-subtle);
}
.view-tab {
  padding: 0.55rem 1.3rem;
  background: none; border: none; cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: all 0.15s;
}
.view-tab:hover { color: var(--color-text-primary); }
.view-tab.active { color: var(--color-accent-primary); border-bottom-color: var(--color-accent-primary); }

.load-more { display: flex; justify-content: center; padding: 1.25rem 0 0.5rem; }

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
.song-album { font-size: var(--fs-sm); color: var(--color-text-secondary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-artist { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-secondary); }
.song-time { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); }

/* tag editor */
.edit-btn {
  background: none; border: none; cursor: pointer;
  color: var(--color-text-muted); font-size: var(--fs-sm);
  padding: 0 0.25rem; opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.song-row:hover .edit-btn { opacity: 1; }
.edit-btn:hover { color: var(--color-accent-primary); }

/* batch selection (songs tab) */
.batch-toolbar {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  border: 1px solid var(--color-accent-dim);
  border-left: 2px solid var(--color-accent-primary);
  background: var(--color-bg-tertiary);
}
.row-check {
  width: 14px; height: 14px;
  accent-color: var(--color-accent-primary);
  cursor: pointer;
}
.song-row.selected { background: var(--color-accent-dim); }
.song-row.selected:hover { background: var(--color-accent-dim); }

/* === 061: Share affordances ===
   share-btn (per-song): absolute-positioned on the right edge so we don't
   have to widen the grid — gives us an extra action without rewriting the
   --grid-cols template that downstream tasks (069 Playlist) will also touch.
   card-share-btn (per-album): top-right of the cover area.
   album-share-btn: standalone button above the song table in album drilldown. */
.song-row { position: relative; }
.share-btn {
  position: absolute;
  right: 0.4rem;
  top: 50%;
  transform: translateY(-50%);
  background: none; border: none; cursor: pointer;
  color: var(--color-text-muted);
  font-size: var(--fs-md);
  padding: 0 0.25rem;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.song-row:hover .share-btn { opacity: 1; }
.share-btn:hover { color: var(--color-accent-primary); }
/* Nudge share-btn left when an edit-btn is also visible so they don't overlap.
   The edit-btn lives inside the grid cell; share-btn floats outside it. */
.song-row .edit-btn ~ .share-btn { right: 1.8rem; }

.album-card { position: relative; }
.card-share-btn {
  position: absolute;
  top: 0.45rem;
  right: 0.5rem;
  z-index: 2;
  background: rgba(10, 10, 11, 0.7);
  border: 1px solid var(--color-border-subtle);
  color: var(--color-accent-primary);
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--fs-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  border-radius: 2px;
}
.album-card:hover .card-share-btn { opacity: 1; }
.card-share-btn:hover { background: var(--color-bg-tertiary); }

.album-share-btn {
  display: block;
  width: 100%;
  text-align: right;
  padding: 0.45rem 1rem;
  background: var(--color-bg-primary);
  border: none;
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-accent-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: background 0.15s;
}
.album-share-btn:hover { background: var(--color-bg-tertiary); }

/* Share modal (singleton at root) */
.share-modal { max-width: 480px; }
.seg-row { display: inline-flex; border: 1px solid var(--color-border-subtle); }
.seg-row .seg-btn {
  background: none; border: none; padding: 0.35rem 0.85rem; cursor: pointer;
  font-family: var(--font-mono); font-size: var(--fs-xs);
  letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--color-text-secondary);
  border-right: 1px solid var(--color-border-subtle);
}
.seg-row .seg-btn:last-child { border-right: none; }
.seg-row .seg-btn:hover { color: var(--color-text-primary); }
.seg-row .seg-btn.active { background: var(--color-accent-dim); color: var(--color-accent-primary); }
.share-created { display: flex; flex-direction: column; gap: 0.45rem; }
.share-url-box {
  padding: 0.5rem 0.65rem;
  background: var(--color-bg-tertiary);
  border-left: 2px solid var(--color-accent-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-accent-primary);
  word-break: break-all;
}
.optional {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.05em;
}

/* === 069: Add-to-Playlist affordances ===
   add-playlist-btn (per-song): absolute-positioned to the LEFT of share-btn
   so they don't collide. share-btn lives at right: 0.4rem; this one sits at
   right: 3.6rem. When an edit-btn is also visible the share-btn floats over
   to right: 1.8rem (see existing rule) so we push this one further to
   right: 4.8rem to keep the gap consistent. */
.add-playlist-btn {
  position: absolute;
  right: 3.6rem;
  top: 50%;
  transform: translateY(-50%);
  background: none; border: none; cursor: pointer;
  color: var(--color-text-muted);
  font-size: var(--fs-md);
  padding: 0 0.25rem;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.song-row:hover .add-playlist-btn { opacity: 1; }
.add-playlist-btn:hover { color: var(--color-accent-primary); }
.song-row .edit-btn ~ .add-playlist-btn { right: 4.8rem; }

.add-playlist-modal { max-width: 480px; }
.add-playlist-list {
  max-height: 320px; overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-secondary);
}
.add-playlist-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.7rem;
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
  transition: background 0.12s;
}
.add-playlist-row:last-child { border-bottom: none; }
.add-playlist-row:hover { background: var(--color-bg-tertiary); }
.add-playlist-name {
  color: var(--color-text-primary); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.create-new-row {
  display: block; width: 100%;
  margin-top: 0.5rem;
  padding: 0.5rem 0.7rem;
  background: none;
  border: 1px dashed var(--color-border-subtle);
  color: var(--color-accent-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.create-new-row:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent-primary);
}
</style>
