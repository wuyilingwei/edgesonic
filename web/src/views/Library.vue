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
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, parseXmlInner, formatDuration } from "../api";
import { usePlayerStore, type Track } from "../stores/player";
import TagEditor from "../components/TagEditor.vue";
import ScrapeButton from "../components/ScrapeButton.vue";
import SongRowMenu from "../components/SongRowMenu.vue";
import type { ScrapeResult } from "../lib/scrape";

const { t } = useI18n();

const { authFetch, writeTags, batchWriteTags, rescanSongs, coverArtUrl, downloadUrl, isAdmin } = useAuth();
const player = usePlayerStore();
const BATCH_MAX = 50;

const props = withDefaults(defineProps<{ starredOnly?: boolean }>(), { starredOnly: false });
const starredOnly = props.starredOnly;

interface Artist { id: string; name: string; albumCount: string; }
interface Album { id: string; name: string; artist: string; year: string; coverArt: string; songCount: string; }

type Tab = "artists" | "albums" | "songs" | "starred";
// users land on tracks (the most common entry point). Switching tabs is still
// honored for the current session, but a re-mount resets to songs.
const tab = ref<Tab>(props.starredOnly ? "starred" : "songs");

const artists = ref<Artist[]>([]);
const albums = ref<Album[]>([]);
const songs = ref<Track[]>([]);

interface StarredLists {
  artists: Artist[];
  albums: Album[];
  songs: Track[];
}
const starredLists = ref<StarredLists>({ artists: [], albums: [], songs: [] });
const starredLoading = ref(false);
const starredLoaded = ref(false);
let starredRequest = 0;

interface ArtistInfo {
  biography: string;
  imageUrl: string;
  lastFmUrl: string;
  mbid: string;
}
const artistInfo = ref<ArtistInfo | null>(null);
const artistInfoLoading = ref(false);
const artistInfoError = ref("");
let artistInfoRequest = 0;

const currentArtist = ref<Artist | null>(null);
const currentAlbum = ref<Album | null>(null);
const loading = ref(false);
const error = ref("");

// === Albums tab (paged grid over the whole library) ===
// First page and every infinite-scroll page use the same size.
const ALBUM_PAGE = 100;
const allAlbums = ref<Album[]>([]);
const albumOffset = ref(0);
const albumsDone = ref(false);

// 154: waterfall grid columns. Went through CSS multi-column (`columns:`)
// first, but that fills strictly column-first — item order on screen no
// longer matches fetch/alphabetical order, and worse, every async cover
// image that finishes loading after initial paint changes that column's
// total height, which can shove *later* items into a different column
// entirely (the whole grid re-flows, reads as flicker). Splitting
// allAlbums into fixed column buckets by index (round-robin) up front
// fixes both: order is deterministic from the source array, and an image
// loading late only grows its own column downward — no cross-column
// reflow.
const WATERFALL_COL_TARGET = 190; // matches the old minmax() card width
const WATERFALL_GAP = 16; // px, mirrors the 1rem gap in CSS below
const albumWaterfallEl = ref<HTMLElement | null>(null);
const waterfallColCount = ref(
  typeof window !== "undefined"
    ? Math.max(1, Math.floor((window.innerWidth + WATERFALL_GAP) / (WATERFALL_COL_TARGET + WATERFALL_GAP)))
    : 4,
);
let waterfallRO: ResizeObserver | null = null;
watch(albumWaterfallEl, (el) => {
  if (waterfallRO) { waterfallRO.disconnect(); waterfallRO = null; }
  if (!el || typeof ResizeObserver === "undefined") return;
  waterfallColCount.value = Math.max(1, Math.floor((el.clientWidth + WATERFALL_GAP) / (WATERFALL_COL_TARGET + WATERFALL_GAP)));
  waterfallRO = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w) waterfallColCount.value = Math.max(1, Math.floor((w + WATERFALL_GAP) / (WATERFALL_COL_TARGET + WATERFALL_GAP)));
  });
  waterfallRO.observe(el);
});
const albumWaterfallCols = computed<Album[][]>(() => {
  const n = waterfallColCount.value;
  const cols: Album[][] = Array.from({ length: n }, () => []);
  allAlbums.value.forEach((al, i) => cols[i % n].push(al));
  return cols;
});

// === Songs tab (paged flat list over the whole library) ===
// bumped from 500 to 1000 per ("默认拉取1k"): the list is a
// flat alphabetical dump so larger pages both cut the number of round-trips
// and make the load-more IntersectionObserver less trigger-happy on arrival.
const SONG_PAGE = 1000;
const allSongs = ref<Track[]>([]);
const songOffset = ref(0);
const songsDone = ref(false);

// IntersectionObserver sentinel elements for the two paged tabs. A single
// observer watches whichever sentinel is currently in the DOM (only one is
// visible at a time since tabs are v-if mutually exclusive); hitting it with
// root=viewport triggers the matching loadMore automatically
// longer has to click "加载更多" by hand.
const songListEnd = ref<HTMLElement | null>(null);
const albumListEnd = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;
function guardLoad(kind: "songs" | "albums"): void {
  if (loading.value) return;
  if (kind === "songs") {
    if (songsDone.value) return;
    void loadMoreSongs();
  } else {
    if (albumsDone.value) return;
    void loadMoreAlbums();
  }
}
function setupObserver(): void {
  if (io || typeof IntersectionObserver === "undefined") return;
  io = new IntersectionObserver((entries) => {
    for (const ent of entries) {
      if (!ent.isIntersecting) continue;
      const el = ent.target as HTMLElement;
      const kind = el.dataset.kind as "songs" | "albums" | undefined;
      if (kind) guardLoad(kind);
    }
  // 155: rootMargin order is (top, right, bottom, left) — this was expanding
  // the *top* of the intersection root, which only matters for content
  // scrolled above the viewport. The sentinel sits below the list, so the
  // "preload before the user hits the literal last pixel" buffer needs to
  // be on the *bottom* instead; as written this sentinel only ever fired
  // once it was pixel-exact inside the visible viewport.
  }, { rootMargin: "0px 0px 600px 0px" });
  if (songListEnd.value) io.observe(songListEnd.value);
  if (albumListEnd.value) io.observe(albumListEnd.value);
}
function refreshTargets(): void {
  if (!io) return;
  // observe() on an already-observed element is a no-op, so this is safe to
  // call from watch(tab) — the sentinel only exists when its tab is active.
  if (songListEnd.value) io.observe(songListEnd.value);
  if (albumListEnd.value) io.observe(albumListEnd.value);
}

function switchTab(next: Tab) {
  tab.value = next;
  currentArtist.value = null;
  currentAlbum.value = null;
  albums.value = [];
  songs.value = [];
  error.value = "";
  artistInfo.value = null;
  artistInfoError.value = "";
  artistInfoRequest++;
  if (next === "artists" && !artists.value.length) loadArtists();
  if (next === "albums" && !allAlbums.value.length) loadMoreAlbums();
  if (next === "songs" && !allSongs.value.length) loadMoreSongs();
  if (next === "starred") void loadStarred(true);
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

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

function artistInfoField(xml: string, tag: string): string {
  return decodeXmlEntities(parseXmlInner(xml, tag).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

async function loadStarred(force = false) {
  if (starredLoading.value || (!force && starredLoaded.value)) return;
  const request = ++starredRequest;
  starredLoading.value = true;
  error.value = "";
  try {
    const xml = await authFetch("getStarred2");
    if (/status="failed"/.test(xml)) throw new Error("getStarred2 failed");
    if (request !== starredRequest) return;
    starredLists.value = {
      artists: parseXmlAttrs(xml, "artist").map((a) => ({
        id: a.id || "", name: a.name || "", albumCount: a.albumCount || "",
      })),
      albums: parseXmlAttrs(xml, "album").map((a) => ({
        id: a.id || "", name: a.name || "", artist: a.artist || "", year: a.year || "",
        coverArt: a.coverArt || "", songCount: a.songCount || "",
      })),
      songs: parseXmlAttrs(xml, "song").map(mapSongRow),
    };
    starredLoaded.value = true;
  } catch {
    if (request === starredRequest) error.value = t("library.starredLoadFailed");
  } finally {
    if (request === starredRequest) starredLoading.value = false;
  }
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

function mapSongRow(s: Record<string, string>): Track {
  return {
    id: s.id || "",
    title: s.title || "",
    artist: s.artist || "",
    album: s.album || "",
    coverArt: s.coverArt || undefined,
    duration: parseInt(s.duration || "0"),
  };
}

async function loadMoreSongs() {
  loading.value = true;
  try {
    const xml = await authFetch("search3", {
      query: "", artistCount: "0", albumCount: "0",
      songCount: String(SONG_PAGE), songOffset: String(songOffset.value),
    });
    const page = parseXmlAttrs(xml, "song").map(mapSongRow);
    allSongs.value.push(...page);
    songOffset.value += page.length;
    if (page.length < SONG_PAGE) songsDone.value = true;
  } catch { error.value = t("library.loadFailed"); }
  loading.value = false;
}

// === Library-wide search (search3), independent of the paged tab lists ===
// Debounced so keystrokes don't hammer the API; searching a non-empty query
// switches the songs/albums/artists tabs out for a combined results view,
// clearing the box restores whichever tab was active before.
const SEARCH_DEBOUNCE_MS = 300;
const searchQuery = ref("");
const searching = ref(false);
const searchResults = ref<{ artists: Artist[]; albums: Album[]; songs: Track[] } | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function runSearch(query: string) {
  searching.value = true;
  // Drop any drilldown so the page-header title/breadcrumb don't show stale
  // artist/album context behind the search results view.
  currentArtist.value = null;
  currentAlbum.value = null;
  try {
    const xml = await authFetch("search3", {
      query, artistCount: "20", albumCount: "20", songCount: "100",
    });
    searchResults.value = {
      artists: parseXmlAttrs(xml, "artist").map((a) => ({
        id: a.id || "", name: a.name || "", albumCount: a.albumCount || "",
      })),
      albums: parseXmlAttrs(xml, "album").map((a) => ({
        id: a.id || "", name: a.name || "", artist: a.artist || "",
        year: a.year || "", coverArt: a.coverArt || "", songCount: a.songCount || "",
      })),
      songs: parseXmlAttrs(xml, "song").map(mapSongRow),
    };
  } catch {
    searchResults.value = { artists: [], albums: [], songs: [] };
  }
  searching.value = false;
}

watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer);
  const query = q.trim();
  if (!query) { searchResults.value = null; return; }
  searchTimer = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
});

function clearSearch() {
  searchQuery.value = "";
  searchResults.value = null;
}

function playFromSearch(i: number) {
  if (searchResults.value) player.setQueue(searchResults.value.songs, i);
}

async function openArtist(artist: Artist) {
  currentArtist.value = artist;
  currentAlbum.value = null;
  songs.value = [];
  artistInfo.value = null;
  artistInfoError.value = "";
  loading.value = true;
  void loadArtistInfo(artist);
  try {
    const xml = await authFetch("getArtist", { id: artist.id });
    albums.value = parseXmlAttrs(xml, "album").map((a) => ({
      id: a.id || "", name: a.name || a.title || "", artist: a.artist || artist.name,
      year: a.year || "", coverArt: a.coverArt || "", songCount: a.songCount || "",
    }));
  } catch { albums.value = []; }
  loading.value = false;
}

async function loadArtistInfo(artist: Artist) {
  const request = ++artistInfoRequest;
  artistInfoLoading.value = true;
  artistInfoError.value = "";
  try {
    const xml = await authFetch("getArtistInfo", { id: artist.id, count: "1" });
    if (/status="failed"/.test(xml)) throw new Error("artist info unavailable");
    if (request !== artistInfoRequest) return;
    const info: ArtistInfo = {
      biography: artistInfoField(xml, "biography"),
      imageUrl: artistInfoField(xml, "largeImageUrl") || artistInfoField(xml, "mediumImageUrl"),
      lastFmUrl: artistInfoField(xml, "lastFmUrl"),
      mbid: artistInfoField(xml, "musicBrainzId"),
    };
    artistInfo.value = info.biography || info.imageUrl || info.lastFmUrl || info.mbid ? info : null;
    if (!artistInfo.value) artistInfoError.value = t("library.artistInfoUnavailable");
  } catch {
    if (request === artistInfoRequest) artistInfoError.value = t("library.artistInfoUnavailable");
  } finally {
    if (request === artistInfoRequest) artistInfoLoading.value = false;
  }
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

function playFromStarred(i: number) {
  player.setQueue(starredLists.value.songs, i);
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
// 149: preload the song's current cover into TagEditor — single mode only,
// batch targets may span different albums so there's no one image to show.
const editExistingCoverUrl = computed(() => {
  if (editorMode.value !== "single") return undefined;
  const coverArt = editTargets.value[0]?.coverArt;
  return coverArt ? coverArtUrl(coverArt, 200) : undefined;
});

// === Edit mode toggle (songs tab, admin-only) ===
// Default OFF: admins land in browse mode; click the ✎ toggle to reveal
// checkboxes, batch-preview, and the batch toolbar. Turning edit mode off
// also clears any pending selection so no ghost state lingers.
const editMode = ref(false);
function toggleEditMode() {
  editMode.value = !editMode.value;
  if (!editMode.value) clearSelection();
}

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

// batch toolbar "重新扫描": force-requeue the selected songs' original
// instances for metadata re-parsing (resets tag_scanned=0 + redispatches a
// work_queue task with upsert:true so an already-completed row actually
// comes back to 'queued'). No modal needed — just a transient inline status
// message next to the toolbar buttons.
const rescanBusy = ref(false);
const rescanMsg = ref("");
async function batchRescan() {
  if (!selectedIds.value.length || rescanBusy.value) return;
  rescanBusy.value = true;
  rescanMsg.value = "";
  try {
    const res = await rescanSongs(selectedIds.value);
    if (res.ok) {
      rescanMsg.value = t("library.rescanQueued", { n: res.dispatched ?? 0 });
      clearSelection();
    } else {
      rescanMsg.value = `${t("library.rescanFailed")}: ${res.error || "unknown"}`;
    }
  } catch (e) {
    rescanMsg.value = `${t("library.rescanFailed")}: ${e instanceof Error ? e.message : String(e)}`;
  }
  rescanBusy.value = false;
  setTimeout(() => { rescanMsg.value = ""; }, 5000);
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
  artistInfo.value = null;
  artistInfoError.value = "";
  artistInfoRequest++;
}

function backToAlbums() {
  currentAlbum.value = null;
  songs.value = [];
}

// === 079: songs-tab discoverability hint ===
// The hint stays at full opacity for 5s after first mount, then fades to 0.5
// so it doesn't keep stealing attention from the song list itself.
const songsHintFaded = ref(false);

onMounted(() => {
  if (tab.value === "artists") loadArtists();
  else if (tab.value === "albums") loadMoreAlbums();
  else if (tab.value === "starred") void loadStarred();
  else loadMoreSongs();
  setTimeout(() => { songsHintFaded.value = true; }, 5000);
  // set up the infinite-scroll observer now that the first sentinel
  // (songs tab, the default) is in the DOM. switchTab's watch below
  // re-observes whichever sentinel becomes live when the user picks a
  // different tab.
  setupObserver();
});

// re-observe the new tab's sentinel after switchTab inserts it. 156: default
// (`pre`) flush runs this callback BEFORE Vue patches the DOM for the tab
// switch, so `albumListEnd`/`songListEnd` were still pointing at the
// *previous* tab's sentinel (or null, the very first time) — `io.observe()`
// was silently a no-op and the newly-active tab's infinite scroll never
// fired again after the first tab switch. Verified with a minimal repro:
// same watcher, default flush read the ref as null; `flush:'post'` read it
// correctly. `flush:'post'` runs this after the DOM update, once the ref is
// actually attached to the new tab's sentinel element.
watch(() => tab.value, () => {
  refreshTargets();
}, { flush: "post" });

watch(() => player.starred, () => {
  if (tab.value === "starred") void loadStarred(true);
});

onUnmounted(() => {
  if (io) { io.disconnect(); io = null; }
  if (waterfallRO) { waterfallRO.disconnect(); waterfallRO = null; }
  if (searchTimer) clearTimeout(searchTimer);
});

// ============================================================================
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
// Set only for the batch-toolbar "share selected" flow — createShare's `id`
// param is repeatable server-side, so a batch share is one call with every
// selected song id rather than N separate shares.
const shareBatchIds = ref<string[] | null>(null);
const shareDescription = ref("");
const shareExpiresType = ref<"never" | "days" | "datetime">("never");
const shareExpiresDays = ref(7);
const shareExpiresAt = ref("");
const shareBusy = ref(false);
const shareError = ref("");
const shareCreatedUrl = ref("");

function openShare(kind: "song" | "album", id: string, label: string) {
  shareTarget.value = { kind, id, label };
  shareBatchIds.value = null;
  shareDescription.value = "";
  shareExpiresType.value = "never";
  shareExpiresDays.value = 7;
  shareExpiresAt.value = "";
  shareError.value = "";
  shareCreatedUrl.value = "";
  shareOpen.value = true;
}
function openBatchShare() {
  if (!selectedIds.value.length) return;
  shareTarget.value = { kind: "song", id: selectedIds.value[0], label: t("library.selected", { n: selectedIds.value.length }) };
  shareBatchIds.value = [...selectedIds.value];
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
  shareBatchIds.value = null;
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
    const params: Record<string, string | string[]> = {
      id: shareBatchIds.value ?? shareTarget.value.id,
    };
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
      if (shareBatchIds.value) clearSelection();
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
//
// Reached from the per-song "⋮" menu (SongRowMenu). Clicking opens a small
// modal listing the caller's playlists; picking one calls updatePlaylist with
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

// === Per-row "⋮" menu ===
// Replaces the old always-visible edit/share/add-to-playlist button cluster —
// one menu per row (keyed by song id) collapses those three actions plus the
// new download action into a single grid column. Only one row's menu is open
// at a time; a window-level click listener closes it when the click lands
// outside any `.row-menu-wrap` (the menu button + popover itself stop
// propagation so they don't immediately close their own click).
const openMenuId = ref<string | null>(null);
function toggleRowMenu(id: string) {
  openMenuId.value = openMenuId.value === id ? null : id;
}
function closeRowMenu() {
  openMenuId.value = null;
}
function onWindowClick(e: MouseEvent) {
  if (!openMenuId.value) return;
  if (!(e.target as HTMLElement).closest(".row-menu-wrap")) closeRowMenu();
}
onMounted(() => window.addEventListener("click", onWindowClick));
onUnmounted(() => window.removeEventListener("click", onWindowClick));
</script>

<template>
  <div class="library">
    <div class="page-header">
      <div>
        <div class="mono-label breadcrumb">
          <a @click="backToList">{{ starredOnly ? t("library.starredBreadcrumb") : t("library.breadcrumb") }}</a>
          <template v-if="currentArtist"> / <a @click="backToAlbums">{{ currentArtist.name }}</a></template>
          <template v-if="currentAlbum"> / <span>{{ currentAlbum.name }}</span></template>
        </div>
        <h1 class="page-title">{{ currentAlbum?.name || currentArtist?.name || (starredOnly ? t("library.starredTitle") : t("library.title")) }}</h1>
      </div>
      <button v-if="currentAlbum && songs.length" class="btn-primary" @click="playAlbumFromStart">{{ t("library.playAlbum") }}</button>
    </div>

    <!-- Library-wide search — always visible, independent of tabs/drilldown. -->
    <div v-if="!starredOnly" class="library-search">
      <input v-model="searchQuery" class="form-input search-input" :placeholder="t('library.searchPlaceholder')" />
      <button v-if="searchQuery" class="search-clear" :title="t('common.close')" @click="clearSearch">✕</button>
    </div>

    <template v-if="!searchResults">
    <!-- View tabs (hidden while drilled into an artist/album) -->
    <div v-if="!starredOnly && !currentArtist && !currentAlbum" class="view-tabs">
      <button :class="['view-tab', { active: tab === 'songs' }]" @click="switchTab('songs')">{{ t("library.tabSongs") }}</button>
      <button :class="['view-tab', { active: tab === 'albums' }]" @click="switchTab('albums')">{{ t("library.tabAlbums") }}</button>
      <button :class="['view-tab', { active: tab === 'artists' }]" @click="switchTab('artists')">{{ t("library.tabArtists") }}</button>
    </div>

    <div v-if="error" class="status-badge error">{{ error }}</div>

    <!-- Drill-down: songs of an album (any tab) -->
    <!-- The trailing 32px track holds the per-row "⋮" menu (SongRowMenu) —
         `auto` tracks are banned since each .table-row is its own grid, so
         content-sized tracks would misalign across rows. -->
    <div v-if="currentAlbum" class="table-wrap song-table" style="--grid-cols: 36px 2fr 1fr 64px 32px">
      <div class="table-header">
        <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span></span>
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
        <SongRowMenu
          :song-id="s.id"
          :title="s.title"
          :is-admin="isAdmin"
          :open="openMenuId === s.id"
          @toggle="toggleRowMenu(s.id)"
          @close="closeRowMenu"
          @edit="openEditor(s)"
          @share="openShare('song', s.id, s.title)"
          @add-playlist="openAddToPlaylist(s.id, s.title)"
        />
      </div>
      <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>
      <div v-else-if="!songs.length" class="empty-state">{{ t("library.noTracks") }}</div>
    </div>

    <!-- Drill-down: albums of an artist -->
    <div v-else-if="currentArtist" class="artist-detail">
      <div class="artist-info card">
        <img
          v-if="artistInfo?.imageUrl"
          class="artist-info-image"
          :src="artistInfo.imageUrl"
          :alt="currentArtist.name"
          loading="lazy"
          @error="artistInfo.imageUrl = ''"
        />
        <div class="artist-info-body">
          <div class="search-section-title">{{ t("library.artistInfoTitle") }}</div>
          <div v-if="artistInfoLoading" class="mono-label">{{ t("library.artistInfoLoading") }}</div>
          <p v-if="artistInfo?.biography" class="artist-biography">{{ artistInfo.biography }}</p>
          <div v-if="artistInfo?.mbid" class="mono-label">MBID: {{ artistInfo.mbid }}</div>
          <a v-if="artistInfo?.lastFmUrl" class="artist-info-link" :href="artistInfo.lastFmUrl" target="_blank" rel="noopener noreferrer">
            {{ t("library.artistInfoOpen") }}
          </a>
          <div v-if="artistInfoError" class="mono-label artist-info-error">{{ artistInfoError }}</div>
        </div>
      </div>
      <div class="album-grid">
      <div v-for="al in albums" :key="al.id" class="card hoverable album-card" @click="openAlbum(al)">
        <div class="album-cover">
          <img v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 256)" :alt="al.name" loading="lazy" @error="al.coverArt = ''" />
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
    </div>
      <div v-if="loading" class="empty-state" style="grid-column: 1/-1">{{ t("common.loading") }}</div>
      <div v-else-if="!albums.length" class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon">◌</div>
        <div>{{ t("library.noAlbums") }}</div>
      </div>
    </div>

    <!-- Tab: starred -->
    <div v-else-if="tab === 'starred'" class="starred-view">
      <div v-if="starredLoading" class="empty-state">{{ t("common.loading") }}</div>
      <template v-else>
        <div v-if="starredLists.artists.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabArtists") }}</div>
          <div class="artist-grid">
            <div v-for="a in starredLists.artists" :key="a.id" class="card hoverable artist-card" @click="openArtist(a)">
              <div class="artist-glyph">{{ a.name.charAt(0).toUpperCase() || "?" }}</div>
              <div class="artist-name">{{ a.name }}</div>
              <div class="mono-label" v-if="a.albumCount">{{ t("library.albumCount", { n: a.albumCount }) }}</div>
              <div class="corner corner-tr"></div>
              <div class="corner corner-bl"></div>
            </div>
          </div>
        </div>

        <div v-if="starredLists.albums.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabAlbums") }}</div>
          <div class="album-grid">
            <div v-for="al in starredLists.albums" :key="al.id" class="card hoverable album-card" @click="openAlbum(al)">
              <div class="album-cover">
                <img v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 256)" :alt="al.name" loading="lazy" @error="al.coverArt = ''" />
                <span v-else class="album-cover-placeholder">♪</span>
              </div>
              <div class="album-body">
                <div class="album-name">{{ al.name }}</div>
                <div class="mono-label">{{ al.artist || "—" }}<template v-if="al.songCount"> · {{ t("library.trackCount", { n: al.songCount }) }}</template></div>
              </div>
              <button class="card-share-btn" :title="t('library.share')" @click.stop="openShare('album', al.id, al.name)">⤴</button>
              <div class="corner corner-tr"></div>
              <div class="corner corner-bl"></div>
            </div>
          </div>
        </div>

        <div v-if="starredLists.songs.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabSongs") }}</div>
          <div class="table-wrap song-table" style="--grid-cols: 36px 2fr 1.5fr 1fr 64px 32px">
            <div class="table-header">
              <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colAlbum") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span></span>
            </div>
            <div
              v-for="(s, i) in starredLists.songs"
              :key="s.id"
              class="table-row song-row"
              :class="{ playing: player.current?.id === s.id }"
              @click="playFromStarred(i)"
            >
              <span class="song-no">{{ player.current?.id === s.id && player.playing ? "▶" : i + 1 }}</span>
              <span class="song-title">{{ s.title }}</span>
              <span class="song-album">{{ s.album }}</span>
              <span class="song-artist">{{ s.artist }}</span>
              <span class="song-time">{{ formatDuration(s.duration) }}</span>
              <SongRowMenu
                :song-id="s.id"
                :title="s.title"
                :is-admin="isAdmin"
                :open="openMenuId === s.id"
                @toggle="toggleRowMenu(s.id)"
                @close="closeRowMenu"
                @edit="openEditor(s)"
                @share="openShare('song', s.id, s.title)"
                @add-playlist="openAddToPlaylist(s.id, s.title)"
              />
            </div>
          </div>
        </div>

        <div v-if="!starredLists.artists.length && !starredLists.albums.length && !starredLists.songs.length" class="empty-state">
          <div class="empty-state-icon">♡</div>
          <div>{{ t("library.noStarred") }}</div>
        </div>
      </template>
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
    <!-- 154: waterfall grid — allAlbums is pre-split into fixed column
         buckets (round-robin by index, see albumWaterfallCols) so on-screen
         order always matches fetch/alphabetical order and a late-loading
         cover only grows its own column, never reflows the whole grid. -->
    <div v-else-if="tab === 'albums'">
      <div class="album-grid album-waterfall" ref="albumWaterfallEl">
        <div v-for="(col, ci) in albumWaterfallCols" :key="ci" class="waterfall-col">
          <div v-for="al in col" :key="al.id" class="card hoverable album-card" @click="openAlbum(al)">
            <div class="album-cover">
              <img v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 256)" :alt="al.name" loading="lazy" @error="al.coverArt = ''" />
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
        </div>
      </div>
      <div v-if="!allAlbums.length && !loading" class="empty-state">
        <div class="empty-state-icon">◌</div>
        <div>{{ t("library.noAlbums") }}</div>
      </div>
      <div class="load-more">
        <span v-if="loading" class="mono-label">{{ t("common.loading") }}</span>
        <!-- invisible IntersectionObserver sentinel replaces the
             manual "加载更多" button. Pulled into the viewport by the
             album grid's natural flow when the user scrolls near the end;
             the observer fires loadMoreAlbums automatically. -->
        <div ref="albumListEnd" class="scroll-sentinel" data-kind="albums" aria-hidden="true"></div>
      </div>
    </div>

    <!-- Tab: all songs -->
    <div v-else-if="tab === 'songs'">
      <!-- 101: edit mode toggle. Admins default to browse mode; click to reveal
           checkboxes / batch toolbar. The button lives at the top-right of the
           songs tab so it's discoverable without cluttering the song list. -->
      <div v-if="isAdmin" class="songs-tab-toolbar">
        <button
          :class="['btn-secondary', 'btn-sm', 'edit-mode-toggle', { 'edit-mode-active': editMode }]"
          @click="toggleEditMode"
        >{{ editMode ? t("library.editModeOff") : t("library.editModeOn") }}</button>
      </div>
      <!-- 079: discoverability hint — explains the per-row ✎ and the batch
           workflow so admins don't have to hover-discover them. Fades to 50%
           opacity after 5s (see songsHintFaded) but stays visible. -->
      <div
        v-if="isAdmin && editMode && allSongs.length > 0"
        class="songs-hint"
        :class="{ faded: songsHintFaded }"
      >{{ t("library.songsHint") }}</div>
      <!-- 079: batch-edit preview row. Shown only when nothing is selected;
           swaps out for the active batch-toolbar below as soon as the user
           ticks a row. -->
      <div v-if="isAdmin && editMode && !selectedIds.length" class="batch-preview">
        <span class="mono-label">{{ t("library.batchHint") }}</span>
      </div>
      <!-- Batch selection toolbar (admin-only) -->
      <div v-if="isAdmin && editMode && selectedIds.length" class="batch-toolbar">
        <span class="mono-label">{{ t("library.selected", { n: selectedIds.length }) }}</span>
        <button class="btn-secondary btn-sm" @click="clearSelection">{{ t("library.clearSelection") }}</button>
        <button
          class="btn-primary btn-sm"
          :disabled="selectedIds.length > BATCH_MAX"
          :title="selectedIds.length > BATCH_MAX ? t('library.batchTooMany') : ''"
          @click="openBatchEditor"
        >{{ t("library.batchEdit") }}</button>
        <button
          class="btn-secondary btn-sm"
          :disabled="rescanBusy || selectedIds.length > BATCH_MAX"
          :title="selectedIds.length > BATCH_MAX ? t('library.batchTooMany') : ''"
          @click="batchRescan"
        >{{ rescanBusy ? t("library.rescanning") : t("library.rescan") }}</button>
        <button
          class="btn-secondary btn-sm"
          :disabled="selectedIds.length > BATCH_MAX"
          :title="selectedIds.length > BATCH_MAX ? t('library.batchTooMany') : ''"
          @click="openBatchShare"
        >{{ t("library.batchShare") }}</button>
        <span v-if="rescanMsg" class="mono-label">{{ rescanMsg }}</span>
      </div>
      <!-- 102: no `auto` tracks (per-row grids misalign); artist/time get
           fixed-share tracks so columns line up across every row. -->
      <div class="table-wrap song-table" :style="`--grid-cols: ${isAdmin && editMode ? '24px ' : ''}36px 2fr 1.5fr 1fr 64px 32px`">
        <div class="table-header">
          <span v-if="isAdmin && editMode"></span>
          <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colAlbum") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span></span>
        </div>
        <div
          v-for="(s, i) in allSongs"
          :key="s.id"
          class="table-row song-row"
          :class="{ playing: player.current?.id === s.id, selected: selectedSet.has(s.id) }"
          @click="playFromAll(i)"
        >
         <input
            v-if="isAdmin && editMode"
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
          <SongRowMenu
            :song-id="s.id"
            :title="s.title"
            :is-admin="isAdmin"
            :open="openMenuId === s.id"
            @toggle="toggleRowMenu(s.id)"
            @close="closeRowMenu"
            @edit="openEditor(s)"
            @share="openShare('song', s.id, s.title)"
            @add-playlist="openAddToPlaylist(s.id, s.title)"
          />
        </div>
        <div v-if="!allSongs.length && !loading" class="empty-state">{{ t("library.noTracks") }}</div>
      </div>
      <div class="load-more">
        <span v-if="loading" class="mono-label">{{ t("common.loading") }}</span>
        <!-- infinite-scroll sentinel (see album tab sibling). -->
        <div ref="songListEnd" class="scroll-sentinel" data-kind="songs" aria-hidden="true"></div>
      </div>
    </div>
    </template>

    <!-- Library-wide search results: replaces tabs/drilldown while a query is active. -->
    <div v-else class="search-results">
      <div v-if="searching" class="empty-state">{{ t("common.loading") }}</div>
      <div
        v-else-if="!searchResults.artists.length && !searchResults.albums.length && !searchResults.songs.length"
        class="empty-state"
      >{{ t("library.searchNoResults") }}</div>
      <template v-else>
        <div v-if="searchResults.artists.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabArtists") }}</div>
          <div class="artist-grid">
            <div
              v-for="a in searchResults.artists"
              :key="a.id"
              class="card hoverable artist-card"
              @click="openArtist(a); clearSearch()"
            >
              <div class="artist-glyph">{{ a.name.charAt(0).toUpperCase() || "?" }}</div>
              <div class="artist-name">{{ a.name }}</div>
              <div class="mono-label" v-if="a.albumCount">{{ t("library.albumCount", { n: a.albumCount }) }}</div>
              <div class="corner corner-tr"></div>
              <div class="corner corner-bl"></div>
            </div>
          </div>
        </div>

        <div v-if="searchResults.albums.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabAlbums") }}</div>
          <div class="album-grid">
            <div
              v-for="al in searchResults.albums"
              :key="al.id"
              class="card hoverable album-card"
              @click="openAlbum(al); clearSearch()"
            >
              <div class="album-cover">
                <img v-if="al.coverArt" :src="coverArtUrl(al.coverArt, 256)" :alt="al.name" loading="lazy" @error="al.coverArt = ''" />
                <span v-else class="album-cover-placeholder">♪</span>
              </div>
              <div class="album-body">
                <div class="album-name">{{ al.name }}</div>
                <div class="mono-label">{{ al.artist || "—" }}<template v-if="al.songCount"> · {{ t("library.trackCount", { n: al.songCount }) }}</template></div>
              </div>
              <button class="card-share-btn" :title="t('library.share')" @click.stop="openShare('album', al.id, al.name)">⤴</button>
              <div class="corner corner-tr"></div>
              <div class="corner corner-bl"></div>
            </div>
          </div>
        </div>

        <div v-if="searchResults.songs.length" class="search-section">
          <div class="search-section-title">{{ t("library.tabSongs") }}</div>
          <div class="table-wrap song-table" style="--grid-cols: 36px 2fr 1.5fr 1fr 64px 32px">
            <div class="table-header">
              <span>#</span><span>{{ t("library.colTitle") }}</span><span>{{ t("library.colAlbum") }}</span><span>{{ t("library.colArtist") }}</span><span>{{ t("library.colTime") }}</span><span></span>
            </div>
            <div
              v-for="(s, i) in searchResults.songs"
              :key="s.id"
              class="table-row song-row"
              :class="{ playing: player.current?.id === s.id }"
              @click="playFromSearch(i)"
            >
              <span class="song-no">{{ player.current?.id === s.id && player.playing ? "▶" : i + 1 }}</span>
              <span class="song-title">{{ s.title }}</span>
              <span class="song-album">{{ s.album }}</span>
              <span class="song-artist">{{ s.artist }}</span>
              <span class="song-time">{{ formatDuration(s.duration) }}</span>
              <SongRowMenu
                :song-id="s.id"
                :title="s.title"
                :is-admin="isAdmin"
                :open="openMenuId === s.id"
                @toggle="toggleRowMenu(s.id)"
                @close="closeRowMenu"
                @edit="openEditor(s)"
                @share="openShare('song', s.id, s.title)"
                @add-playlist="openAddToPlaylist(s.id, s.title)"
              />
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Tag editor (single + batch) -->
    <TagEditor
      :open="editorOpen"
      :mode="editorMode"
      :song-ids="editTargets.map((t) => t.id)"
      :initial-tags="editInitial"
      :existing-cover-url="editExistingCoverUrl"
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

/* library-wide search */
.library-search {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 1rem;
  max-width: 360px;
}
.search-input { width: 100%; padding-right: 2rem; }
.search-clear {
  position: absolute;
  right: 0.5rem;
  background: none; border: none; cursor: pointer;
  color: var(--color-text-muted);
  font-size: var(--fs-sm);
  padding: 0.2rem;
}
.search-clear:hover { color: var(--color-accent-primary); }

.search-section { margin-bottom: 1.75rem; }
.search-section-title {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: 0.6rem;
}

.load-more { display: flex; justify-content: center; padding: 1.25rem 0 0.5rem; }
/* invisible IntersectionObserver sentinel: must occupy vertical space
   inside the scroll flow so the observer can see it approach the viewport.
   1px tall is enough; a tiny margin keeps it clear of grid/table borders. */
.scroll-sentinel { width: 1px; height: 1px; margin: 0; padding: 0; }

/* artists */
.artist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 1rem; align-items: start; }
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

.artist-detail { display: flex; flex-direction: column; gap: 1rem; }
.artist-info {
  display: flex; gap: 1rem; align-items: flex-start;
  padding: 1rem;
}
.artist-info-image {
  width: 120px; height: 120px; flex: 0 0 120px;
  object-fit: cover; border: 1px solid var(--color-border-subtle);
}
.artist-info-body { min-width: 0; }
.artist-biography {
  margin: 0 0 0.7rem; color: var(--color-text-secondary);
  line-height: 1.6; white-space: pre-wrap;
}
.artist-info-link { color: var(--color-accent-primary); font-family: var(--font-mono); font-size: var(--fs-sm); }
.artist-info-error { color: var(--color-text-muted); }
.starred-view { display: flex; flex-direction: column; gap: 0.2rem; }

/* albums */
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 1rem; align-items: start; }
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

/* 154: waterfall grid for the full-library albums tab. allAlbums is
   pre-split into fixed column buckets in script (round-robin by index, see
   albumWaterfallCols) and each bucket renders as its own independent
   vertical flex stack — that's what makes it a waterfall rather than a
   uniform grid: a column with a two-line album name just runs longer, it
   doesn't force every other column's row band to match its height the way
   CSS Grid auto-rows would.
   Covers stay at the fixed 1:1 aspect ratio from the base .album-cover rule
   (deliberately NOT switched to natural image aspect ratio) — that was
   tried and reverted: it made each cover's box grow/jump the moment its
   image finished decoding, and because that happens near-simultaneously
   for a whole viewport of covers on load, it read as repeated flicker.
   Column buckets being fixed by index (not by running content height, like
   CSS multi-column `columns:` used before) also means a cover loading late
   only pushes down its own column — never reshuffles items into a
   different column. */
.album-waterfall {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
}
.waterfall-col {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1 1 0;
  min-width: 0;
}
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
.song-artist { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-secondary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-time { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); }

/* 079: songs-tab discoverability hint. Sits above the song table on admins
   only; auto-fades to 50% opacity after 5s (see songsHintFaded). */
.songs-hint {
  color: var(--color-text-muted);
  font-size: 0.85rem;
  padding: 0.5rem 1rem;
  margin-bottom: 0.5rem;
  border-left: 2px solid var(--color-accent-dim);
  background: var(--color-bg-tertiary);
  opacity: 1;
  transition: opacity 0.4s ease;
}
.songs-hint.faded { opacity: 0.5; }

/* 101: songs-tab edit mode toggle. Aligns to the right so it doesn't steal
   attention from the song list; turns accent-colored when edit mode is on. */
.songs-tab-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.5rem;
}
.edit-mode-toggle { font-family: var(--font-mono); font-size: var(--fs-sm); }
.edit-mode-active {
  border-color: var(--color-accent-primary, #6366f1);
  color: var(--color-accent-primary, #6366f1);
}

/* 079: batch-edit preview row. Displaces itself in favour of batch-toolbar
   the moment a row is ticked, so the two never stack. */
.batch-preview {
  display: flex; align-items: center;
  padding: 0.45rem 0.75rem;
  margin-bottom: 0.75rem;
  border: 1px dashed var(--color-border-subtle);
  color: var(--color-text-muted);
  background: var(--color-bg-secondary);
}

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

/* === Share affordances ===
   card-share-btn (per-album): top-right of the cover area.
   album-share-btn: standalone button above the song table in album drilldown.
   Per-song share now lives inside the SongRowMenu "⋮" dropdown (see that
   component) rather than as its own row button. */
.song-row { position: relative; }
/* :deep() reaches into SongRowMenu's scoped .row-menu-btn — dimmed by
   default (matches the old edit/share/add-playlist affordances), full
   opacity when its row is hovered. */
.song-row:hover :deep(.row-menu-btn) { opacity: 1; }

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

@media (max-width: 560px) {
  .view-tab { padding-left: 0.7rem; padding-right: 0.7rem; font-size: var(--fs-xs); }
  .artist-info { flex-direction: column; }
  .artist-info-image { width: 88px; height: 88px; flex-basis: 88px; }
}
</style>
