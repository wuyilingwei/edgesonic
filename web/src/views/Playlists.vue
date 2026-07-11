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
//
// Backend (034):
//   GET /rest/getPlaylists                                         list
//   GET /rest/getPlaylist?id=                                      detail
//   GET /rest/createPlaylist?name=[&songId=...]                    create new
//   GET /rest/createPlaylist?playlistId=&songId=...                overwrite tracks
//  GET /rest/updatePlaylist?playlistId=
//                          [&name=&comment=&public=]
//                          [&songIdToAdd=...]
//                            [&songIndexToRemove=...]              partial
//   GET /rest/deletePlaylist?id=                                   remove
//
// We deliberately keep detail-view inline (no nested route) — playback queue
// and PlayerBar already live in App.vue; switching routes would force users to
// re-pick a playlist after every back-navigation.
//
// Reorder is implemented by re-calling createPlaylist with the existing
// playlistId + the new songId[] order (the worker route handles that as a
// full replace via replacePlaylistSongs). This is simpler than maintaining a
// move endpoint and matches Subsonic conventions.
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, formatDuration } from "../api";
import { usePlayerStore, type Track } from "../stores/player";

const { t } = useI18n();
const { authFetch, coverArtUrl, username } = useAuth();
const player = usePlayerStore();

// ===========================================================================
// Types
// ===========================================================================
interface Playlist {
  id: string;
  name: string;
  comment: string;
  owner: string;
  public: boolean;
  songCount: number;
  duration: number;
  created: string;
  changed: string;
  coverArt: string;
}
interface PlaylistEntry extends Track {
  position: number; // 1-based for display; index in array is what we send back
}

// ===========================================================================
// State
// ===========================================================================
const playlists = ref<Playlist[]>([]);
const loading = ref(false);

// Detail view — when currentPlaylist != null we show entries instead of list.
const currentPlaylist = ref<Playlist | null>(null);
const entries = ref<PlaylistEntry[]>([]);
const detailLoading = ref(false);

// Create form
const showCreate = ref(false);
const createForm = ref({ name: "", comment: "", public: false });
const createBusy = ref(false);

// Edit meta form (in detail view)
const showEdit = ref(false);
const editForm = ref({ name: "", comment: "", public: false });
const editBusy = ref(false);

// Add-song modal (in detail view)
const showAddSong = ref(false);
const addSongQuery = ref("");
const addSongResults = ref<Array<{ id: string; title: string; artist: string; album: string }>>([]);
const addSongBusy = ref(false);

// Tiny toast — Shares.vue uses the same pattern; copying here keeps the view
// independent (no new components).
const toast = ref({ show: false, msg: "", type: "success" as "success" | "error" });
function showToast(msg: string, type: "success" | "error" = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 2500);
}

// ===========================================================================
// XML helpers
// ===========================================================================
function failed(xml: string): boolean { return /status="failed"/.test(xml); }
function extractError(xml: string): string | null {
  const m = /<error[^>]+message="([^"]+)"/.exec(xml);
  return m ? m[1] : null;
}
function decodeAttr(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parsePlaylist(attrs: Record<string, string>): Playlist {
  return {
    id: attrs.id || "",
    name: decodeAttr(attrs.name || ""),
    comment: decodeAttr(attrs.comment || ""),
    owner: attrs.owner || "",
    public: attrs.public === "true",
    songCount: parseInt(attrs.songCount || "0", 10) || 0,
    duration: parseInt(attrs.duration || "0", 10) || 0,
    created: attrs.created || "",
    changed: attrs.changed || "",
    coverArt: attrs.coverArt || "",
  };
}

function parseEntry(attrs: Record<string, string>, idx: number): PlaylistEntry {
  return {
    id: attrs.id || "",
    title: decodeAttr(attrs.title || ""),
    artist: decodeAttr(attrs.artist || ""),
    album: decodeAttr(attrs.album || ""),
    coverArt: attrs.coverArt || undefined,
    duration: parseInt(attrs.duration || "0", 10) || 0,
    position: idx + 1,
  };
}

// ===========================================================================
// Load playlists
// ===========================================================================
async function loadPlaylists() {
  loading.value = true;
  try {
    const xml = await authFetch("getPlaylists");
    playlists.value = parseXmlAttrs(xml, "playlist").map(parsePlaylist);
  } catch {
    playlists.value = [];
  } finally {
    loading.value = false;
  }
}

async function openPlaylist(p: Playlist) {
  currentPlaylist.value = p;
  entries.value = [];
  detailLoading.value = true;
  try {
    const xml = await authFetch("getPlaylist", { id: p.id });
    // Refresh the playlist meta from the latest server snapshot — counts may
    // have shifted between list load and detail open.
    const meta = parseXmlAttrs(xml, "playlist")[0];
    if (meta) currentPlaylist.value = parsePlaylist(meta);
    entries.value = parseXmlAttrs(xml, "entry").map(parseEntry);
  } catch {
    entries.value = [];
  } finally {
    detailLoading.value = false;
  }
}

function backToList() {
  currentPlaylist.value = null;
  entries.value = [];
  showEdit.value = false;
  showAddSong.value = false;
  addSongResults.value = [];
  addSongQuery.value = "";
}

// ===========================================================================
// Create
// ===========================================================================
function openCreate() {
  createForm.value = { name: "", comment: "", public: false };
  showCreate.value = true;
}
function closeCreate() { showCreate.value = false; }

async function submitCreate() {
  const name = createForm.value.name.trim();
  if (!name) { showToast(t("playlists.nameRequired"), "error"); return; }
  createBusy.value = true;
  try {
    const xml = await authFetch("createPlaylist", { name });
    if (failed(xml)) throw new Error(extractError(xml) || "create failed");
    // Created playlist might need comment/public set via updatePlaylist
    // (createPlaylist only takes name + songId). Round-trip if needed.
    const created = parseXmlAttrs(xml, "playlist")[0];
    const newId = created?.id;
    const comment = createForm.value.comment.trim();
    const wantPublic = createForm.value.public;
    if (newId && (comment || wantPublic)) {
      const patch: Record<string, string> = { playlistId: newId };
      if (comment) patch.comment = comment;
      if (wantPublic) patch.public = "true";
      const xml2 = await authFetch("updatePlaylist", patch);
      if (failed(xml2)) {
        showToast(t("playlists.updateFailed"), "error");
      }
    }
    showToast(t("playlists.created"));
    closeCreate();
    await loadPlaylists();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("playlists.createFailed")}: ${msg}`, "error");
  } finally {
    createBusy.value = false;
  }
}

// ===========================================================================
// Edit meta (detail view)
// ===========================================================================
function openEdit() {
  if (!currentPlaylist.value) return;
  editForm.value = {
    name: currentPlaylist.value.name,
    comment: currentPlaylist.value.comment,
    public: currentPlaylist.value.public,
  };
  showEdit.value = true;
}
function closeEdit() { showEdit.value = false; }

async function submitEdit() {
  if (!currentPlaylist.value) return;
  const id = currentPlaylist.value.id;
  const params: Record<string, string> = { playlistId: id };
  const name = editForm.value.name.trim();
  if (name) params.name = name;
  // Send empty string to clear comment per worker semantics (comment === "" → null).
  params.comment = editForm.value.comment.trim();
  params.public = editForm.value.public ? "true" : "false";
  editBusy.value = true;
  try {
    const xml = await authFetch("updatePlaylist", params);
    if (failed(xml)) throw new Error(extractError(xml) || "update failed");
    showToast(t("playlists.updated"));
    closeEdit();
    // Refresh detail to pick up the new meta.
    if (currentPlaylist.value) await openPlaylist(currentPlaylist.value);
    // Also refresh the cached list so list view is consistent on back-nav.
    await loadPlaylists();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("playlists.updateFailed")}: ${msg}`, "error");
  } finally {
    editBusy.value = false;
  }
}

// ===========================================================================
// Delete playlist
// ===========================================================================
async function deletePlaylist(p: Playlist) {
  if (!confirm(t("playlists.confirmDelete", { name: p.name }))) return;
  try {
    const xml = await authFetch("deletePlaylist", { id: p.id });
    if (failed(xml)) throw new Error(extractError(xml) || "delete failed");
    showToast(t("playlists.deleted"));
    // If we deleted the currently-open playlist, pop back to the list.
    if (currentPlaylist.value?.id === p.id) backToList();
    playlists.value = playlists.value.filter((x) => x.id !== p.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("playlists.deleteFailed")}: ${msg}`, "error");
  }
}

// ===========================================================================
// Songs — add, remove, reorder
// ===========================================================================
function openAddSong() {
  addSongQuery.value = "";
  addSongResults.value = [];
  showAddSong.value = true;
}
function closeAddSong() {
  showAddSong.value = false;
  addSongResults.value = [];
}

async function searchAddSong() {
  const q = addSongQuery.value.trim();
  if (!q) { addSongResults.value = []; return; }
  addSongBusy.value = true;
  try {
    const xml = await authFetch("search3", {
      query: q,
      songCount: "20",
      albumCount: "0",
      artistCount: "0",
    });
    addSongResults.value = parseXmlAttrs(xml, "song").map((s) => ({
      id: s.id || "",
      title: decodeAttr(s.title || ""),
      artist: decodeAttr(s.artist || ""),
      album: decodeAttr(s.album || ""),
    }));
  } catch {
    addSongResults.value = [];
  } finally {
    addSongBusy.value = false;
  }
}

async function addSong(songId: string) {
  if (!currentPlaylist.value) return;
  try {
    const xml = await authFetch("updatePlaylist", {
      playlistId: currentPlaylist.value.id,
      songIdToAdd: songId,
    });
    if (failed(xml)) throw new Error(extractError(xml) || "add failed");
    showToast(t("playlists.songAdded"));
    closeAddSong();
    await openPlaylist(currentPlaylist.value);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("playlists.songAddFailed")}: ${msg}`, "error");
  }
}

async function removeSong(idx: number) {
  if (!currentPlaylist.value) return;
  try {
    const xml = await authFetch("updatePlaylist", {
      playlistId: currentPlaylist.value.id,
      songIndexToRemove: String(idx),
    });
    if (failed(xml)) throw new Error(extractError(xml) || "remove failed");
    showToast(t("playlists.songRemoved"));
    await openPlaylist(currentPlaylist.value);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("playlists.songRemoveFailed")}: ${msg}`, "error");
  }
}

// Swap two indices and persist via createPlaylist(playlistId, songId[]) which
// the worker treats as a full replace through replacePlaylistSongs.
//
// NB: authFetch's Record<string,string> shape collapses duplicate keys; we
// need true repeated `songId=...` query parameters, so build the URL by hand
// using signedParams() from useAuth().
async function moveSong(idx: number, dir: -1 | 1) {
  if (!currentPlaylist.value) return;
  const target = idx + dir;
  if (target < 0 || target >= entries.value.length) return;
  const ordered = [...entries.value];
  [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];

  // Optimistic local update for snappy UX; rolled back on failure.
  const prev = entries.value;
  entries.value = ordered.map((e, i) => ({ ...e, position: i + 1 }));
  try {
    await sendCreatePlaylistOrdered(currentPlaylist.value.id, ordered.map((e) => e.id));
    await openPlaylist(currentPlaylist.value);
  } catch (e) {
    entries.value = prev;
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("playlists.reorderFailed")}: ${msg}`, "error");
  }
}

const { signedParams } = useAuth();
async function sendCreatePlaylistOrdered(playlistId: string, songIds: string[]) {
  const qs = signedParams({ playlistId });
  for (const id of songIds) qs.append("songId", id);
  const resp = await fetch(`/rest/createPlaylist?${qs.toString()}`);
  const xml = await resp.text();
  if (failed(xml)) throw new Error(extractError(xml) || "reorder failed");
}

// ===========================================================================
// Playback
// ===========================================================================
function playFromEntry(i: number) {
  // entries already share the Track shape (id/title/artist/album/coverArt/duration).
  player.setQueue(entries.value as Track[], i);
}
function playAll() {
  if (entries.value.length) player.setQueue(entries.value as Track[], 0);
}

// ===========================================================================
// Derived
// ===========================================================================
const canEdit = computed(() =>
  currentPlaylist.value ? currentPlaylist.value.owner === username.value : false,
);

onMounted(loadPlaylists);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("playlists.label") }}</div>
        <h1 class="page-title">
          <a v-if="currentPlaylist" class="back-link" @click="backToList">← {{ t("playlists.back") }}</a>
          <span v-else>{{ t("playlists.title") }}</span>
        </h1>
      </div>
      <button v-if="!currentPlaylist" class="btn-primary" @click="openCreate">{{ t("playlists.create") }}</button>
      <div v-else-if="canEdit" class="header-actions">
        <button class="btn-secondary btn-sm" @click="openAddSong">{{ t("playlists.addSong") }}</button>
        <button class="btn-secondary btn-sm" @click="openEdit">{{ t("playlists.edit") }}</button>
        <button class="btn-danger btn-sm" @click="deletePlaylist(currentPlaylist)">{{ t("playlists.delete") }}</button>
      </div>
    </div>

    <!-- ===========================================================
         List view
         =========================================================== -->
    <template v-if="!currentPlaylist">
      <div v-if="loading && !playlists.length" class="empty-state">
        <div class="empty-state-icon">◌</div>
        <div>{{ t("common.loading") }}</div>
      </div>
      <div v-else-if="!playlists.length" class="empty-state">
        <div class="empty-state-icon">◌</div>
        <div>{{ t("playlists.empty") }}</div>
      </div>
      <div v-else class="playlist-list">
        <div
          v-for="p in playlists"
          :key="p.id"
          class="card playlist-card"
          @click="openPlaylist(p)"
        >
         <div class="playlist-cover">
            <img v-if="p.coverArt" :src="coverArtUrl(p.coverArt, 256)" :alt="p.name" loading="lazy" />
            <span v-else class="playlist-cover-placeholder">♫</span>
          </div>
          <div class="playlist-body">
            <div class="playlist-name">{{ p.name }}</div>
            <div class="playlist-meta mono-label">
              <span>{{ t("playlists.songCount", { n: p.songCount }) }}</span>
              <span>·</span>
              <span>{{ formatDuration(p.duration) }}</span>
              <span>·</span>
              <span :class="['visibility', p.public ? 'public' : 'private']">
                {{ p.public ? t("playlists.public") : t("playlists.private") }}
              </span>
            </div>
            <div v-if="p.comment" class="playlist-comment">{{ p.comment }}</div>
          </div>
          <div class="corner corner-tr"></div>
          <div class="corner corner-bl"></div>
        </div>
      </div>
    </template>

    <!-- ===========================================================
         Detail view
         =========================================================== -->
    <template v-else>
      <div class="detail-header">
        <div class="detail-cover">
          <img v-if="currentPlaylist.coverArt" :src="coverArtUrl(currentPlaylist.coverArt, 256)" :alt="currentPlaylist.name" />
          <span v-else class="playlist-cover-placeholder">♫</span>
        </div>
        <div class="detail-meta">
          <div class="mono-label">{{ currentPlaylist.public ? t("playlists.public") : t("playlists.private") }}</div>
          <h2 class="detail-title">{{ currentPlaylist.name }}</h2>
          <div class="detail-row mono-label">
            <span>{{ t("playlists.songCount", { n: currentPlaylist.songCount }) }}</span>
            <span>·</span>
            <span>{{ formatDuration(currentPlaylist.duration) }}</span>
            <span v-if="currentPlaylist.owner">·</span>
            <span v-if="currentPlaylist.owner">{{ currentPlaylist.owner }}</span>
          </div>
          <div v-if="currentPlaylist.comment" class="detail-comment">{{ currentPlaylist.comment }}</div>
          <button v-if="entries.length" class="btn-primary" style="margin-top: 0.75rem" @click="playAll">
            {{ t("playlists.playAll") }}
          </button>
        </div>
      </div>

      <h3 class="songs-title mono-label">{{ t("playlists.songsTitle") }}</h3>

      <div v-if="detailLoading && !entries.length" class="empty-state">
        <div class="empty-state-icon">◌</div>
        <div>{{ t("common.loading") }}</div>
      </div>
      <div v-else-if="!entries.length" class="empty-state">
        <div class="empty-state-icon">♪</div>
        <div>{{ t("playlists.noSongs") }}</div>
      </div>
      <div v-else class="entry-table">
        <div class="entry-row" v-for="(e, i) in entries" :key="`${e.id}-${i}`">
          <span class="entry-num" @click="playFromEntry(i)">{{ player.current?.id === e.id && player.playing ? "▶" : i + 1 }}</span>
          <span class="entry-title-cell" @click="playFromEntry(i)">{{ e.title }}</span>
          <span class="entry-artist" @click="playFromEntry(i)">{{ e.artist }}</span>
          <span class="entry-time" @click="playFromEntry(i)">{{ formatDuration(e.duration) }}</span>
          <div v-if="canEdit" class="entry-actions">
            <button
              class="row-btn"
              :title="t('playlists.moveUp')"
              :disabled="i === 0"
              @click.stop="moveSong(i, -1)"
            >↑</button>
            <button
              class="row-btn"
              :title="t('playlists.moveDown')"
              :disabled="i === entries.length - 1"
              @click.stop="moveSong(i, 1)"
            >↓</button>
            <button
              class="row-btn danger"
              :title="t('playlists.removeSong')"
              @click.stop="removeSong(i)"
            >✕</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ===========================================================
         Create modal
         =========================================================== -->
    <div v-if="showCreate" class="modal-backdrop" @click.self="closeCreate">
      <div class="modal">
        <div class="modal-title">{{ t("playlists.create") }}</div>
        <div style="display:flex; flex-direction:column; gap:0.7rem">
          <div class="form-group">
            <label class="form-label">{{ t("playlists.name") }}</label>
            <input v-model="createForm.name" class="form-input" :placeholder="t('playlists.namePlaceholder')" autofocus />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("playlists.comment") }} <span class="optional">({{ t("playlists.optional") }})</span></label>
            <input v-model="createForm.comment" class="form-input" />
          </div>
          <label class="checkbox-row">
            <input v-model="createForm.public" type="checkbox" />
            <span>{{ t("playlists.publicFlag") }}</span>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeCreate">{{ t("playlists.cancel") }}</button>
          <button class="btn-primary" :disabled="createBusy" @click="submitCreate">
            {{ createBusy ? t("common.loading") : t("playlists.save") }}
          </button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- ===========================================================
         Edit modal
         =========================================================== -->
    <div v-if="showEdit" class="modal-backdrop" @click.self="closeEdit">
      <div class="modal">
        <div class="modal-title">{{ t("playlists.edit") }}</div>
        <div style="display:flex; flex-direction:column; gap:0.7rem">
          <div class="form-group">
            <label class="form-label">{{ t("playlists.name") }}</label>
            <input v-model="editForm.name" class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("playlists.comment") }}</label>
            <input v-model="editForm.comment" class="form-input" />
          </div>
          <label class="checkbox-row">
            <input v-model="editForm.public" type="checkbox" />
            <span>{{ t("playlists.publicFlag") }}</span>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeEdit">{{ t("playlists.cancel") }}</button>
          <button class="btn-primary" :disabled="editBusy" @click="submitEdit">
            {{ editBusy ? t("common.loading") : t("playlists.save") }}
          </button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- ===========================================================
         Add-song modal
         =========================================================== -->
    <div v-if="showAddSong" class="modal-backdrop" @click.self="closeAddSong">
      <div class="modal add-song-modal">
        <div class="modal-title">{{ t("playlists.addSong") }}</div>
        <div class="search-row">
          <input
            v-model="addSongQuery"
            class="form-input"
            :placeholder="t('playlists.searchSong')"
            @keydown.enter.prevent="searchAddSong"
            autofocus
          />
          <button class="btn-secondary" :disabled="addSongBusy" @click="searchAddSong">
            {{ addSongBusy ? t("common.loading") : t("playlists.searchBtn") }}
          </button>
        </div>
        <div v-if="addSongResults.length" class="search-results">
          <div
            v-for="r in addSongResults"
            :key="r.id"
            class="search-result"
            @click="addSong(r.id)"
          >
           <div class="result-label">{{ r.title }}</div>
            <div class="result-sub">{{ r.artist }}<template v-if="r.album"> — {{ r.album }}</template></div>
          </div>
        </div>
        <div v-else-if="!addSongBusy && addSongQuery" class="empty-state empty-search">
          {{ t("playlists.noSearchResults") }}
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeAddSong">{{ t("playlists.cancel") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.back-link { cursor: pointer; color: var(--color-accent-primary); }
.back-link:hover { color: var(--color-text-primary); }

.header-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-end; }

/* ===== list view ===== */
.playlist-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}
.playlist-card {
  display: grid;
  grid-template-columns: 86px 1fr;
  gap: 0.85rem;
  padding: 0.75rem;
  cursor: pointer;
  position: relative;
}
.playlist-cover {
  width: 86px; height: 86px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.playlist-cover img { width: 100%; height: 100%; object-fit: cover; }
.playlist-cover-placeholder { font-size: 1.8rem; color: var(--color-text-muted); }
.playlist-body { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.playlist-name {
  font-weight: 700; font-size: var(--fs-md); color: var(--color-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.playlist-meta { display: flex; gap: 0.35rem; flex-wrap: wrap; align-items: center; }
.visibility.public { color: var(--color-accent-primary); }
.visibility.private { color: var(--color-text-muted); }
.playlist-comment {
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ===== detail view ===== */
.detail-header {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 1.25rem;
  margin-bottom: 1.5rem;
}
.detail-cover {
  width: 180px; height: 180px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
.detail-cover img { width: 100%; height: 100%; object-fit: cover; }
.detail-meta { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
.detail-title { font-size: 1.75rem; color: var(--color-text-primary); margin: 0; }
.detail-row { display: flex; gap: 0.35rem; flex-wrap: wrap; align-items: center; }
.detail-comment {
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  padding: 0.45rem 0.6rem;
  background: var(--color-bg-tertiary);
  border-left: 2px solid var(--color-accent-primary);
  margin-top: 0.4rem;
}

.songs-title {
  margin: 0 0 0.5rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--color-border-subtle);
}

.entry-table { display: flex; flex-direction: column; gap: 0; }
.entry-row {
  display: grid;
  grid-template-columns: 36px 1fr 1fr auto auto;
  gap: 0.6rem;
  align-items: center;
  padding: 0.5rem 0.4rem;
  border-bottom: 1px solid var(--color-border-subtle);
  transition: background 0.12s;
}
.entry-row:hover { background: var(--color-bg-tertiary); }
.entry-num {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
  text-align: right;
  cursor: pointer;
}
.entry-title-cell { font-size: var(--fs-md); color: var(--color-text-primary); cursor: pointer; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry-artist { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-secondary); cursor: pointer; }
.entry-time { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); cursor: pointer; }
.entry-actions { display: flex; gap: 0.25rem; }
.row-btn {
  background: none;
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-secondary);
  cursor: pointer;
  width: 26px; height: 26px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--fs-sm);
  transition: all 0.12s;
}
.row-btn:hover:not(:disabled) { color: var(--color-accent-primary); border-color: var(--color-accent-primary); }
.row-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.row-btn.danger:hover:not(:disabled) { color: #e74c3c; border-color: #e74c3c; }

/* ===== modal-shared ===== */
.checkbox-row {
  display: inline-flex; align-items: center; gap: 0.45rem;
  font-size: var(--fs-sm); color: var(--color-text-secondary);
  cursor: pointer;
}
.checkbox-row input { accent-color: var(--color-accent-primary); }
.optional {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.05em;
}

/* add-song modal */
.add-song-modal { max-width: 560px; }
.search-row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
.search-row .form-input { flex: 1; }
.search-results {
  max-height: 320px; overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-secondary);
}
.search-result {
  padding: 0.5rem 0.7rem;
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
}
.search-result:last-child { border-bottom: none; }
.search-result:hover { background: var(--color-bg-tertiary); }
.result-label { color: var(--color-text-primary); font-weight: 600; font-size: var(--fs-sm); }
.result-sub {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  margin-top: 0.1rem;
}
.empty-search { padding: 0.75rem; }
</style>
