<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, formatDuration } from "../api";
import { usePlayerStore, type Track } from "../stores/player";
import TagEditor from "../components/TagEditor.vue";

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

async function onEditorSubmit(patch: Record<string, string | number>) {
  if (!editTargets.value.length || !Object.keys(patch).length) return;
  editBusy.value = true; editMsg.value = ""; editErr.value = false;

  try {
    if (editorMode.value === "single") {
      const target = editTargets.value[0];
      const res = await writeTags(target.id, patch);
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
      const res = await batchWriteTags(ids, patch);
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
    />
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
</style>
