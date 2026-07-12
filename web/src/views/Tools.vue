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
// used to live inside Settings; they are workflows rather than configuration,
// so they get their own page with one sub-page per direction. The credential
// form is shared — both directions talk to the same upstream server.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import { useWorkerPool } from "../stores/workerPool";
import { mapConcurrent } from "../lib/concurrency";
import { normalizeForMatch } from "../lib/trackMatch";

const { t } = useI18n();
const { isSuperAdmin, edgesonicPost, edgesonicFetch, rescanSongs, md5, signedParams, restUrl } = useAuth();
const workerPool = useWorkerPool();

// "auto-start in mm:ss" countdown next to the manual poll button.
// workerPool.nextPollAt is a plain timestamp (not itself ticking), so a
// local 1s clock drives the countdown text reactively.
const nowTick = ref(Date.now());
const autoStartCountdownText = computed(() => {
  const eta = workerPool.nextPollAt;
  if (!eta || eta <= nowTick.value) return "";
  const totalSec = Math.ceil((eta - nowTick.value) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
});

// ---- 110: Work pool status (moved from Dashboard) ----
interface WorkCounts { queued: number; claimed: number; completed: number; failed: number; canceled: number }
interface WorkLoadRow { username: string; n: number }
const workCounts = ref<WorkCounts>({ queued: 0, claimed: 0, completed: 0, failed: 0, canceled: 0 });
const workLoad = ref<WorkLoadRow[]>([]);
const totalTasks = computed(() => workCounts.value.queued + workCounts.value.claimed + workCounts.value.completed + workCounts.value.failed);
const progressPct = computed(() => totalTasks.value > 0 ? Math.round((workCounts.value.completed / totalTasks.value) * 100) : 0);

// Global speed / ETA — sampled from the aggregate work/status counts (all
// browsers combined), same windowed-rate technique workerPool.ts uses for
// its own (this-browser-only) speedPerMin. Local speed is exposed directly
// by the store; this just adds the aggregate view alongside it.
// switched from a noisy 5-min real-time window to a 15-min rolling
// average (SAMPLE_LIMIT 120 ~ 20 min of 10s status polls) so the number
// stabilises instead of swinging with every batch. ETA uses the same
// averaged speed but applies a 0.8 conservative coefficient
// wanted "拉长估算" rather than the instantaneous rate, so we deliberately
// over-estimate remaining time by 25%. This accounts for the queue being
// served in bursts (other browsers may pause, scans can re-queue) and
// keeps the displayed ETA honest rather than optimistic.
const SPEED_WINDOW_MS = 15 * 60 * 1000;
const SAMPLE_LIMIT = 120;
const globalSamples = ref<Array<{ ts: number; count: number }>>([]);
function recordGlobalSample() {
  globalSamples.value.push({ ts: Date.now(), count: workCounts.value.completed });
  if (globalSamples.value.length > SAMPLE_LIMIT) {
    globalSamples.value.splice(0, globalSamples.value.length - SAMPLE_LIMIT);
  }
}
const globalSpeedPerMin = computed<number | null>(() => {
  const samples = globalSamples.value;
  if (samples.length < 2) return null;
  const now = Date.now();
  const cutoff = now - SPEED_WINDOW_MS;
  let oldest = samples[0];
  for (const s of samples) { if (s.ts >= cutoff) { oldest = s; break; } }
  const elapsed = now - oldest.ts;
  if (elapsed < 1000) return null;
  const delta = workCounts.value.completed - oldest.count;
  if (delta <= 0) return null;
  return Math.round((delta * 60_000) / elapsed * 10) / 10;
});
const etaText = computed<string>(() => {
  const speed = globalSpeedPerMin.value;
  const remaining = workCounts.value.queued + workCounts.value.claimed;
  if (remaining <= 0) return "—";
  if (!speed) return "—";
  // 0.8 conservative coefficient — see comment above.
  const effectiveSpeed = speed * 0.8;
  if (effectiveSpeed <= 0) return "—";
  const minutes = Math.ceil(remaining / effectiveSpeed);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
});

async function loadWorkStatus() {
  try {
    const text = await edgesonicFetch("work/status");
    const parsed = JSON.parse(text) as { ok?: boolean; counts?: Partial<WorkCounts>; load?: WorkLoadRow[] };
    if (parsed.ok) {
      workCounts.value = { queued: parsed.counts?.queued ?? 0, claimed: parsed.counts?.claimed ?? 0, completed: parsed.counts?.completed ?? 0, failed: parsed.counts?.failed ?? 0, canceled: parsed.counts?.canceled ?? 0 };
      workLoad.value = Array.isArray(parsed.load) ? parsed.load : [];
      recordGlobalSample();
    }
  } catch { /* stay quiet */ }
}

// Concurrency knob — moved here from Settings .
// saving writes localStorage via workerPool.setMaxConcurrent (no server
// POST). Concurrency only affects this browser's poll limit, so persisting
// it server-side as a shared feature_string was both wasteful and misleading.
const maxConcurrentInput = ref<number>(workerPool.maxConcurrent);
const maxConcurrentBusy = ref(false);
function saveMaxConcurrent() {
  const n = Math.max(1, Math.min(8, Math.floor(Number(maxConcurrentInput.value) || 0)));
  maxConcurrentInput.value = n;
  maxConcurrentBusy.value = true;
  try {
    workerPool.setMaxConcurrent(n);
    showToast("并发度已保存到本机");
  } finally {
    maxConcurrentBusy.value = false;
  }
}

async function onResetFailedWork() {
  try { await edgesonicPost("maintenance/resetFailedWork", {}); await loadWorkStatus(); } catch { /* */ }
}
async function onReclaimStaleWork() {
  try { await edgesonicPost("maintenance/reclaimStaleWork", {}); await loadWorkStatus(); } catch { /* */ }
}

// ---- 110: Storage + R2 cost (moved from Dashboard) ----
interface StorageRow { source_type: string; count: number; bytes: number }
interface StorageStats { breakdown: StorageRow[]; r2CoverCount: number; r2CoverBytes: number; freeAllocationGb: number }
const storageStats = ref<StorageStats | null>(null);
const storageLoading = ref(false);
const freeAllocInput = ref(10);
const freeAllocSaving = ref(false);
const R2_PRICE_PER_GB = 0.015;
const r2Row = computed(() => storageStats.value?.breakdown.find((r) => r.source_type === "r2") ?? { source_type: "r2", count: 0, bytes: 0 });
const r2TotalBytes = computed(() => r2Row.value.bytes + (storageStats.value?.r2CoverBytes ?? 0));
const r2Gb = computed(() => r2TotalBytes.value / 1024 ** 3);
const billableGb = computed(() => Math.max(0, r2Gb.value - freeAllocInput.value));
const monthlyCost = computed(() => billableGb.value * R2_PRICE_PER_GB);

async function loadStorageStats() {
  storageLoading.value = true;
  try {
    const text = await edgesonicFetch("stats/storage");
    const data = JSON.parse(text) as { ok?: boolean } & Partial<StorageStats>;
    if (data.ok) {
      storageStats.value = { breakdown: data.breakdown ?? [], r2CoverCount: data.r2CoverCount ?? 0, r2CoverBytes: data.r2CoverBytes ?? 0, freeAllocationGb: data.freeAllocationGb ?? 10 };
      freeAllocInput.value = storageStats.value.freeAllocationGb;
    }
  } catch { /* */ } finally { storageLoading.value = false; }
}

async function saveFreeAlloc() {
  freeAllocSaving.value = true;
  try { await edgesonicPost("features/updateString", { key: "r2_free_allocation_gb", value: String(freeAllocInput.value) }); } catch { /* */ } finally { freeAllocSaving.value = false; }
}

// ---- Orphan songs (files.ts upload placeholder bucket that never got
// relinked to real artist/album — see worker/src/endpoints/edgesonic/
// maintenance.ts's orphanSongs endpoints for the full rationale) ----
interface OrphanSong {
  masterId: string; title: string; createdAt: number; instanceCount: number;
  suffix: string | null; totalSize: number; tagScanned: number; missing: boolean;
}
const orphanSongs = ref<OrphanSong[]>([]);
const orphanLoading = ref(false);
const orphanSelected = ref<string[]>([]);
const orphanSelectedSet = computed(() => new Set(orphanSelected.value));
const orphanAllSelected = computed(() => orphanSongs.value.length > 0 && orphanSelected.value.length === orphanSongs.value.length);
const orphanRescanBusy = ref(false);
const orphanDeleteBusy = ref(false);

async function loadOrphanSongs() {
  orphanLoading.value = true;
  try {
    const data = JSON.parse(await edgesonicFetch("maintenance/orphanSongs")) as { ok?: boolean; songs?: OrphanSong[] };
    orphanSongs.value = data.songs ?? [];
    const stillPresent = new Set(orphanSongs.value.map((s) => s.masterId));
    orphanSelected.value = orphanSelected.value.filter((id) => stillPresent.has(id));
  } catch {
    orphanSongs.value = [];
  } finally {
    orphanLoading.value = false;
  }
}

function toggleOrphanSelect(id: string) {
  const idx = orphanSelected.value.indexOf(id);
  if (idx >= 0) orphanSelected.value.splice(idx, 1);
  else orphanSelected.value.push(id);
}
function toggleOrphanAll() {
  orphanSelected.value = orphanAllSelected.value ? [] : orphanSongs.value.map((s) => s.masterId);
}

async function rescanSelectedOrphans() {
  if (!orphanSelected.value.length || orphanRescanBusy.value) return;
  orphanRescanBusy.value = true;
  try {
    const res = await rescanSongs(orphanSelected.value);
    showToast(res.ok ? `已重新加入扫描队列 ${res.dispatched ?? 0} 个` : `重新扫描失败：${res.error || "unknown"}`, res.ok ? "success" : "error");
    orphanSelected.value = [];
    await loadOrphanSongs();
  } catch (e) {
    showToast(`重新扫描失败：${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    orphanRescanBusy.value = false;
  }
}

async function deleteSelectedOrphans() {
  if (!orphanSelected.value.length || orphanDeleteBusy.value) return;
  orphanDeleteBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("maintenance/orphanSongs/delete", { masterIds: orphanSelected.value })) as
      { ok?: boolean; deleted?: number; failed?: number; error?: string };
    if (data.ok) {
      showToast(`已删除 ${data.deleted ?? 0} 首${data.failed ? `，失败 ${data.failed} 首` : ""}`, data.failed ? "error" : "success");
    } else {
      showToast(`删除失败：${data.error || "unknown"}`, "error");
    }
    orphanSelected.value = [];
    await loadOrphanSongs();
  } catch (e) {
    showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    orphanDeleteBusy.value = false;
  }
}

function formatOrphanDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}

// handle, so it leaked a new 10s poller every time this component
// (re)mounted (e.g. navigating away from /tools and back). Store the handle
// and clear it on unmount, same pattern as Files.vue's workStatusHandle.
let workStatusPollHandle: ReturnType<typeof setInterval> | null = null;
let nowTickHandle: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void loadWorkStatus();
  void loadStorageStats();
  void loadOrphanSongs();
  workStatusPollHandle = window.setInterval(() => { if (!document.hidden) void loadWorkStatus(); }, 10000);
  nowTickHandle = window.setInterval(() => { nowTick.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (workStatusPollHandle !== null) { clearInterval(workStatusPollHandle); workStatusPollHandle = null; }
  if (nowTickHandle !== null) { clearInterval(nowTickHandle); nowTickHandle = null; }
});

// === Toast (same shape as Settings.vue's) ===
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

// (same open/toggleSection shape) instead of the bespoke `.tools-accordion`
// this page used to have. Clone + Push are now one section ("migrate") with
// an internal seg-btn switch (migrateMode) instead of two separate
// top-level accordion entries.
type SectionKey = "migrate" | "workPool" | "storage" | "orphanSongs";
const open = ref<Record<SectionKey, boolean>>({ migrate: false, workPool: false, storage: false, orphanSongs: false });
function toggleSection(key: SectionKey) { open.value[key] = !open.value[key]; }
const migrateMode = ref<"clone" | "push">("clone");

// Browser-driven clone: the SPA fetches metadata + bytes directly from the
// upstream Subsonic server (using Subsonic MD5 token auth: t = md5(password
// + salt), s = salt) and POSTs each item to /edgesonic/clone/* to persist
// locally. Keeping the loop client-side avoids Worker CPU-time timeouts
// when the upstream library is large.
//
// Stages run sequentially:
//  1. metadata — getAlbumList2 → getAlbum → upsertMaster per song
//   2. audio   — (optional) stream → ingestAudio per song
//  3. playlists — getPlaylists → getPlaylist → upsertPlaylist
//   4. starred — getStarred2 → upsertStarred
//   5. users   — (admin upstream only) getUsers → upsertUser
//
// Each stage exposes a reactive progress object so the UI can render
// "X / Y" counters and a per-stage status pill.
interface CloneForm { url: string; username: string; password: string; }
const cloneForm = ref<CloneForm>({ url: "", username: "", password: "" });
// 161: on by default (matches the pre-existing always-on behavior) — the
// toggle exists so a re-run that only needs starred/playlists/users doesn't
// have to re-walk the whole library's metadata every time.
const cloneMetadataEnabled = ref(true);
const cloneAudioEnabled = ref(false);
// "browser" (default): fetch upstream bytes in the browser then POST to
// ingestAudio — more resilient on flaky upstreams, costs the operator's own
// bandwidth twice (down then up). "worker": the Worker fetches upstream
// bytes itself and writes straight to R2 — saves the browser-side bandwidth
// entirely, at the cost of running through the Worker's own outbound
// subrequest (less forgiving of a slow/unstable upstream).
const cloneAudioMode = ref<"browser" | "worker">("browser");
const cloneUsersEnabled = ref(false);
const cloneProxyEnabled = ref(false);
const clonePlaylistOnly = ref(false);
const cloneStarredOnly = ref(false);
const cloneRunning = ref(false);
const cloneCancelRequested = ref(false);
const cloneFilterSongIds = ref<Set<string> | null>(null);

interface CloneProgress {
  total: number;
  done: number;
  failed: number;
  status: "idle" | "running" | "done" | "error" | "skipped";
  message: string;
}
function newCloneProgress(): CloneProgress {
  return { total: 0, done: 0, failed: 0, status: "idle", message: "" };
}
const cloneStages = ref({
  metadata: newCloneProgress(),
  audio: newCloneProgress(),
  playlists: newCloneProgress(),
  starred: newCloneProgress(),
  users: newCloneProgress(),
});
const cloneLog = ref<string[]>([]);
function cloneLogPush(line: string) {
  cloneLog.value.push(line);
  if (cloneLog.value.length > 500) cloneLog.value.splice(0, cloneLog.value.length - 500);
}

// 159: resume cache — a cancelled/interrupted/failed clone used to mean
// starting over from song #1 next time: every album gets re-walked and
// every song's audio gets re-fetched-and-reuploaded from scratch, even the
// ones that already landed locally last run. Persist the set of song ids
// that have already been metadata-upserted / audio-uploaded to
// localStorage, keyed per upstream URL (so cloning two different servers
// doesn't cross-contaminate completion state), and skip re-processing
// anything already in the set. Re-running after a cancel/crash then just
// picks up where it left off instead of redoing already-finished work.
interface CloneCache { metadataDone: string[]; audioDone: string[] }
function cloneCacheKey(): string {
  return "edgesonic_clone_cache_" + md5(cloneForm.value.url.trim().toLowerCase());
}
function cloneSourceKey(): string {
  return md5(cloneForm.value.url.trim().toLowerCase());
}
function loadCloneCache(): { metadataDone: Set<string>; audioDone: Set<string> } {
  try {
    const raw = localStorage.getItem(cloneCacheKey());
    if (!raw) return { metadataDone: new Set(), audioDone: new Set() };
    const parsed = JSON.parse(raw) as CloneCache;
    return {
      metadataDone: new Set(parsed.metadataDone || []),
      audioDone: new Set(parsed.audioDone || []),
    };
  } catch {
    return { metadataDone: new Set(), audioDone: new Set() };
  }
}
let cloneCache = { metadataDone: new Set<string>(), audioDone: new Set<string>() };
let cloneCacheDirty = false;
let cloneCacheFlushTimer: ReturnType<typeof setTimeout> | null = null;
function saveCloneCacheNow() {
  cloneCacheDirty = false;
  try {
    localStorage.setItem(cloneCacheKey(), JSON.stringify({
      metadataDone: Array.from(cloneCache.metadataDone),
      audioDone: Array.from(cloneCache.audioDone),
    } satisfies CloneCache));
  } catch {
    // localStorage full/disabled — resume just won't work next time, not fatal.
  }
}
// Debounced so a fast library (hundreds of items/sec once cache-hit-skipping
// kicks in) doesn't hammer localStorage with a synchronous write per item.
function markCloneCacheDirty() {
  cloneCacheDirty = true;
  if (cloneCacheFlushTimer) return;
  cloneCacheFlushTimer = setTimeout(() => {
    cloneCacheFlushTimer = null;
    if (cloneCacheDirty) saveCloneCacheNow();
  }, 1000);
}
const cloneCacheClearedAt = ref(0); // bump to re-render the "N cached" hint after clearing
function clearCloneCache() {
  if (cloneCacheFlushTimer) { clearTimeout(cloneCacheFlushTimer); cloneCacheFlushTimer = null; }
  try { localStorage.removeItem(cloneCacheKey()); } catch { /* ignore */ }
  cloneCache = { metadataDone: new Set(), audioDone: new Set() };
  cloneCacheDirty = false;
  cloneCacheClearedAt.value = Date.now();
  showToast(t("settings.common.clone.cacheCleared"));
}
// Reactive-ish counts for the template hint — read at render time via a
// computed so cloneCacheClearedAt / cloneForm.url changes refresh it.
const cloneCacheCounts = computed(() => {
  void cloneCacheClearedAt.value; // dependency: recompute after clearCloneCache()
  void cloneForm.value.url;
  const c = loadCloneCache();
  return { metadata: c.metadataDone.size, audio: c.audioDone.size };
});

// mapConcurrent (shared, see lib/concurrency.ts) replaced the fully
// sequential `for...await` this clone used to do — CLONE_*_CONCURRENCY
// bounds how many albums/songs are in flight at once (does NOT cap the
// total item count, which is already fully paginated before this runs).
const CLONE_METADATA_CONCURRENCY = 4;
const CLONE_AUDIO_CONCURRENCY = 3;

// Build the upstream Subsonic auth query string for a single call.
// t = md5(password + salt), s = salt — the same scheme EdgeSonic uses
// in api.ts:signedParams, but signed with the *upstream* password.
// 163: parameterized on username/password (rather than always reading
// cloneForm.value) so cloneUsersStage can authenticate as each cloned user
// in turn to pull *their own* starred/playlists — Subsonic's getStarred2
// has no "give me user X's stars" param for a regular client, the only way
// to get another user's personal data is to actually sign in as them (and
// upstream getUsers already hands us their password for this exact reason).
function cloneSignedParamsFor(username: string, password: string, extra?: Record<string, string>): URLSearchParams {
  const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
  return new URLSearchParams({
    u: username,
    t: md5(password + s),
    s,
    v: "1.16.1",
    c: "EdgeSonicClone",
    f: "json",
    ...extra,
  });
}
function cloneSignedParams(extra?: Record<string, string>): URLSearchParams {
  return cloneSignedParamsFor(cloneForm.value.username, cloneForm.value.password, extra);
}

function cloneUpstreamUrlFor(username: string, password: string, path: string, params?: Record<string, string>): string {
  const base = cloneForm.value.url.replace(/\/+$/, "");
  return `${base}/rest/${path}?${cloneSignedParamsFor(username, password, params).toString()}`;
}
function cloneUpstreamUrl(path: string, params?: Record<string, string>): string {
  return cloneUpstreamUrlFor(cloneForm.value.username, cloneForm.value.password, path, params);
}

// Subsonic JSON responses come back as { "subsonic-response": { ... } }.
// We tolerate either JSON or XML for getAlbumList2/getAlbum/getSong etc;
// when the server only speaks XML (older Navidrome / supysonic), we parse
// the attributes out of the XML.
async function cloneFetchJsonAs(username: string, password: string, path: string, params?: Record<string, string>): Promise<any> {
  const resp = cloneProxyEnabled.value
    ? await fetch("/edgesonic/clone/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upstreamUrl: cloneForm.value.url,
          username, password,
          path,
          params: params || {},
          binary: false,
        }),
      })
    : await fetch(cloneUpstreamUrlFor(username, password, path, params));
  const text = await resp.text();
  try {
    const json = JSON.parse(text);
    return json?.["subsonic-response"] ?? json;
  } catch {
    return { _xml: text };
  }
}
async function cloneFetchJson(path: string, params?: Record<string, string>): Promise<any> {
  return cloneFetchJsonAs(cloneForm.value.username, cloneForm.value.password, path, params);
}

// Generic attribute parser for XML-fallback responses.
function parseXmlChildren(xml: string, tag: string): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  const re = new RegExp(`<${tag}\\s+([^>]+?)\\s*/?>`, "g");
  let m;
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = am[2];
    items.push(attrs);
  }
  return items;
}

// Pull a value from a Subsonic JSON node OR fall back to the XML parse.
function jget(node: any, key: string): string | undefined {
  if (node && typeof node === "object") {
    const v = node[key];
    if (typeof v === "string" || typeof v === "number") return String(v);
    // Some Subsonic servers wrap scalars in { _value: ... } — handle both.
    if (v && typeof v === "object" && "_value" in v) return String((v as any)._value);
  }
  return undefined;
}

// Normalize a Subsonic song node (from getAlbum.songs / getStarred2.song /
// getPlaylist.entries) into the shape upsertMaster expects.
function normalizeSongNode(song: any, album: any, artist: any): {
  artist: { id: string; name: string; sortName?: string | null };
  album: { id: string; name: string; sortName?: string | null; year?: number | null; genre?: string | null };
  song: {
    id: string; albumId: string; artistId: string; albumArtistId?: string | null;
    title: string; sortTitle?: string | null;
    track?: number | null; disc?: number | null;
    duration?: number | null; genre?: string | null;
    compilation?: number | null;
  };
  albumArtist?: { id: string; name: string; sortName?: string | null };
} {
  const artistName = jget(song, "artist") || jget(album, "artist") || jget(artist, "name") || "Unknown Artist";
  const albumArtistName = jget(song, "albumArtist") || jget(album, "artist") || artistName;
  const artistId = jget(song, "artistId") || jget(artist, "id") || "ar-" + simpleHash(artistName);
  const albumId = jget(song, "albumId") || jget(album, "id") || "al-" + simpleHash(albumArtistName + " " + (jget(album, "name") || "Unknown Album"));
  const albumArtistId = (jget(song, "albumArtistId") || "ar-" + simpleHash(albumArtistName)) ?? null;

  return {
    artist: {
      id: artistId,
      name: artistName,
      sortName: artistName.toLowerCase(),
    },
    album: {
      id: albumId,
      name: jget(album, "name") || jget(song, "album") || "Unknown Album",
      sortName: (jget(album, "name") || jget(song, "album") || "Unknown Album").toLowerCase(),
      year: numOr(jget(album, "year") || jget(song, "year"), null),
      genre: jget(album, "genre") || jget(song, "genre") || null,
    },
    song: {
      id: jget(song, "id") || "sm-clone-" + simpleHash(artistName + (jget(song, "title") || "") + albumId),
      albumId,
      artistId,
      albumArtistId: albumArtistId === artistId ? null : albumArtistId,
      title: jget(song, "title") || "Unknown Title",
      sortTitle: (jget(song, "title") || "Unknown Title").toLowerCase(),
      track: numOr(jget(song, "track"), null),
      disc: numOr(jget(song, "discNumber"), null),
      duration: numOr(jget(song, "duration"), null),
      genre: jget(song, "genre") || null,
      compilation: jget(album, "isCompilation") === "true" ? 1 : 0,
    },
    albumArtist: albumArtistId && albumArtistId !== artistId
      ? { id: albumArtistId, name: albumArtistName, sortName: albumArtistName.toLowerCase() }
      : undefined,
  };
}

function numOr(v: string | undefined, fallback: number | null): number | null {
  if (v === undefined || v === null || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Tiny non-crypto hash for synthesising Subsonic-style ids when the upstream
// server omits them. Subsonic ids are opaque strings so a stable 10-char
// hash matches the EdgeSonic convention (ar-/al-/sm- prefixes use md5[:10]).
function simpleHash(input: string): string {
  // Reuse the project's md5 from api.ts for stable ids.
  return md5(input).substring(0, 10);
}

// Sanitise a path component for R2 keys — replaces path separators and trims.
function sanitizePathPart(s: string, fallback: string): string {
  const cleaned = (s || "").replace(/[\/\\]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned || fallback;
}

// Format bytes for the log.
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function buildCloneFilterSet(): Promise<Set<string> | null> {
  if (!clonePlaylistOnly.value && !cloneStarredOnly.value) return null;
  const out = new Set<string>();

  if (clonePlaylistOnly.value) {
    const resp = await cloneFetchJson("getPlaylists");
    let playlists: any[] = [];
    if (resp?._xml) playlists = parseXmlChildren(resp._xml, "playlist");
    else {
      const raw = resp?.playlists?.playlist || [];
      playlists = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    }
    for (const p of playlists) {
      if (cloneCancelRequested.value) break;
      const id = jget(p, "id") || "";
      if (!id) continue;
      const detail = await cloneFetchJson("getPlaylist", { id });
      let entries: any[] = [];
      if (detail?._xml) entries = parseXmlChildren(detail._xml, "entry");
      else {
        const raw = detail?.playlist?.entry || detail?.entries?.entry || [];
        entries = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      }
      for (const e of entries) {
        const sid = jget(e, "id") || e.id || "";
        if (sid) out.add(String(sid));
      }
    }
  }

  if (cloneStarredOnly.value) {
    const resp = await cloneFetchJson("getStarred2");
    let songs: any[] = [];
    if (resp?._xml) songs = parseXmlChildren(resp._xml, "song");
    else {
      const raw = resp?.starred2?.song || resp?.starred?.song || [];
      songs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    }
    for (const s of songs) {
      const sid = jget(s, "id") || s.id || "";
      if (sid) out.add(String(sid));
    }
  }

  return out;
}

// Stage 1 — metadata. Walk getAlbumList2 (alphabeticalByName, large size),
// then getAlbum per album, then POST /clone/upsertMaster per song.
async function cloneMetadataStage() {
  const stage = cloneStages.value.metadata;
  if (!cloneMetadataEnabled.value) {
    stage.status = "skipped";
    stage.message = "disabled";
    return;
  }
  stage.status = "running";
  stage.message = "";
  const PAGE = 500;
  let offset = 0;
  const albumIds: { id: string; name: string; artist: string }[] = [];
  // year/genre live on the album-list entry itself (Subsonic AlbumID3), so
  // this same paginated walk doubles as the metadata lookup search3 below
  // needs — no per-album getAlbum call required just to learn them.
  const albumMeta = new Map<string, { name: string; artist: string; year?: string; genre?: string }>();
  while (!cloneCancelRequested.value) {
    const resp = await cloneFetchJson("getAlbumList2", { type: "alphabeticalByName", size: String(PAGE), offset: String(offset) });
    let arr: Record<string, string>[] = [];
    if (resp?._xml) {
      arr = parseXmlChildren(resp._xml, "album");
    } else {
      const albums = resp?.albumList2?.album || resp?.albums?.album || [];
      arr = Array.isArray(albums) ? albums : (albums ? [albums] : []);
    }
    if (arr.length === 0) break;
    for (const a of arr) {
      const id = jget(a, "id") || "";
      const name = jget(a, "name") || "Unknown Album";
      const artist = jget(a, "artist") || jget(a, "artistId") || "";
      albumIds.push({ id, name, artist });
      if (id) albumMeta.set(id, { name, artist, year: jget(a, "year"), genre: jget(a, "genre") });
    }
    if (arr.length < PAGE) break;
    offset += PAGE;
  }
  cloneLogPush(`metadata: ${albumIds.length} album(s) discovered, scanning for songs…`);

  interface MetaItem { s: any; albumNode: any; artist: string }

  // 162: search3 with an empty query is the "list everything" convention
  // this app's own Songs tab already relies on (Navidrome-compatible) — one
  // paginated walk gets every song directly, each entry already carrying
  // albumId/artistId/track/genre/duration/…, instead of one getAlbum
  // round-trip per album. For a library of e.g. 2000 albums that's the
  // difference between ~4 requests and ~2000.
  async function collectViaSearch3(): Promise<MetaItem[]> {
    const out: MetaItem[] = [];
    const SONG_PAGE = 500;
    let songOffset = 0;
    while (!cloneCancelRequested.value) {
      const resp = await cloneFetchJson("search3", {
        query: "", songCount: String(SONG_PAGE), songOffset: String(songOffset),
        albumCount: "0", artistCount: "0",
      });
      let songs: any[] = [];
      if (resp?._xml) {
        songs = parseXmlChildren(resp._xml, "song");
      } else {
        const raw = resp?.searchResult3?.song || resp?.searchResult2?.song || [];
        songs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      }
      if (songs.length === 0) break;
      for (const s of songs) {
        const sid = jget(s, "id") || "";
        if (cloneFilterSongIds.value && sid && !cloneFilterSongIds.value.has(sid)) continue;
        const aid = jget(s, "albumId") || "";
        const am = albumMeta.get(aid);
        out.push({
          s,
          albumNode: { id: aid, name: am?.name || jget(s, "album"), artist: am?.artist || jget(s, "artist"), year: am?.year, genre: am?.genre },
          artist: jget(s, "artist") || am?.artist || "",
        });
      }
      if (songs.length < SONG_PAGE) break;
      songOffset += SONG_PAGE;
    }
    return out;
  }

  // Fallback for upstreams that don't honor the empty-query convention
  // (some strict spec-only servers return zero results instead of "all").
  // Detected by getting nothing back from search3 despite having just
  // discovered real albums above — not proactive, so well-behaved upstreams
  // never pay for both walks.
  async function collectViaGetAlbum(): Promise<MetaItem[]> {
    const out: MetaItem[] = [];
    await mapConcurrent(albumIds, CLONE_METADATA_CONCURRENCY, async (meta) => {
      try {
        const albumResp = await cloneFetchJson("getAlbum", { id: meta.id });
        let albumNode: any = meta;
        let songs: any[] = [];
        if (albumResp?._xml) {
          // XML fallback — parse <album .../> and <song .../> siblings.
          const albumMatch = /<album\s+([^>]+?)\s*\/?>/.exec(albumResp._xml);
          if (albumMatch) {
            const attrs: Record<string, string> = {};
            const attrRe = /(\w+)="([^"]*)"/g;
            let am;
            while ((am = attrRe.exec(albumMatch[1]))) attrs[am[1]] = am[2];
            albumNode = attrs;
          }
          songs = parseXmlChildren(albumResp._xml, "song");
        } else {
          albumNode = albumResp?.album || albumNode;
          const raw = albumResp?.album?.song || albumResp?.songs?.song || [];
          songs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        }
        const keptSongs = cloneFilterSongIds.value
          ? songs.filter((s) => {
              const sid = jget(s, "id") || "";
              return !sid || cloneFilterSongIds.value!.has(sid);
            })
          : songs;
        for (const s of keptSongs) out.push({ s, albumNode, artist: meta.artist });
      } catch (e: unknown) {
        cloneLogPush(`metadata: ✗ album ${meta.name} (scan) — ${e instanceof Error ? e.message : String(e)}`);
      }
    }, () => cloneCancelRequested.value);
    return out;
  }

  let items: MetaItem[] = albumIds.length ? await collectViaSearch3() : [];
  if (items.length === 0 && albumIds.length > 0) {
    cloneLogPush(`metadata: search3 returned no songs despite ${albumIds.length} album(s) — falling back to per-album scan`);
    items = await collectViaGetAlbum();
  }

  stage.total = items.length;
  cloneLogPush(`metadata: ${items.length} song(s) to upload`);

  await mapConcurrent(items, CLONE_METADATA_CONCURRENCY, async ({ s, albumNode, artist }) => {
    const sid = jget(s, "id") || "";
    // Metadata is intentionally re-upserted even when cached so the backend can
    // refresh the source-scoped remote-id -> local-id map used by audio,
    // playlists and starred items.
    const payload = normalizeSongNode(s, albumNode, { id: "", name: artist });
    try {
      const data = JSON.parse(await edgesonicPost("clone/upsertMaster", { ...payload, sourceKey: cloneSourceKey() }));
      if (!data.ok) throw new Error(data.error || "upsertMaster rejected");
      stage.done++;
      if (sid) { cloneCache.metadataDone.add(sid); markCloneCacheDirty(); }
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`metadata: ✗ ${payload.song.title} — ${e instanceof Error ? e.message : String(e)}`);
    }
  // 159: mapConcurrent's isCancelled param was never wired up here — it only
  // stopped a lane from picking up the *next* item, but nothing was even
  // passing it, so the cancel button had no effect on this stage at all.
  }, () => cloneCancelRequested.value);
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
  stage.message = cloneCancelRequested.value ? "cancelled" : "";
}

// Stage 2 — audio. For every song_master already cloned, fetch the upstream
// /rest/stream bytes and POST them to /clone/ingestAudio.
async function cloneAudioStage() {
  const stage = cloneStages.value.audio;
  if (!cloneAudioEnabled.value) {
    stage.status = "skipped";
    stage.message = "disabled";
    return;
  }
  stage.status = "running";
  // We re-walk getAlbumList2 / getAlbum to get song ids + paths so the
  // browser doesn't need a separate "list of cloned masters" round-trip.
  // The upsertMaster stage already inserted the rows, so ingestAudio's
  // masterId lookup will succeed.
  const PAGE = 500;
  let offset = 0;
  const albumMetas: { id: string; name: string; artist: string }[] = [];
  while (!cloneCancelRequested.value) {
    const resp = await cloneFetchJson("getAlbumList2", { type: "alphabeticalByName", size: String(PAGE), offset: String(offset) });
    let albums: any[] = [];
    if (resp?._xml) {
      albums = parseXmlChildren(resp._xml, "album");
    } else {
      const raw = resp?.albumList2?.album || resp?.albums?.album || [];
      albums = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    }
    if (albums.length === 0) break;
    for (const a of albums) {
      albumMetas.push({
        id: jget(a, "id") || "",
        name: jget(a, "name") || "Unknown Album",
        artist: jget(a, "artist") || "Unknown Artist",
      });
    }
    if (albums.length < PAGE) break;
    offset += PAGE;
  }

  // 160: the per-album getAlbum walk used to be a plain sequential `for`
  // loop with stage.total only set after everything had been fetched —
  // 158 made it concurrent and grew stage.total live as each album
  // resolved, but a total that keeps climbing while the row already reads
  // "running" is just a different kind of confusing (is it done counting
  // or not?). Collect fully first (still concurrent, so still fast) and
  // set stage.total exactly once, to its real final value.
  const allSongs: { id: string; title: string; album: string; albumId: string; artist: string; suffix: string; contentType: string; size: number; path: string }[] = [];
  await mapConcurrent(albumMetas, CLONE_METADATA_CONCURRENCY, async (meta) => {
    if (cloneCancelRequested.value) return;
    const detail = await cloneFetchJson("getAlbum", { id: meta.id });
    let songs: any[] = [];
    if (detail?._xml) {
      songs = parseXmlChildren(detail._xml, "song");
    } else {
      const raw = detail?.album?.song || detail?.songs?.song || [];
      songs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    }
    const keptSongs = cloneFilterSongIds.value
      ? songs.filter((s) => {
          const sid = jget(s, "id") || "";
          return !sid || cloneFilterSongIds.value!.has(sid);
        })
      : songs;
    for (const s of keptSongs) {
      allSongs.push({
        id: jget(s, "id") || "",
        title: jget(s, "title") || "Unknown Title",
        album: meta.name,
        albumId: meta.id,
        artist: jget(s, "artist") || meta.artist,
        suffix: (jget(s, "suffix") || jget(s, "format") || "mp3").toLowerCase(),
        contentType: jget(s, "contentType") || suffixToMime((jget(s, "suffix") || "mp3").toLowerCase()),
        size: numOr(jget(s, "size"), 0) || 0,
        path: jget(s, "path") || "",
      });
    }
  }, () => cloneCancelRequested.value);
  stage.total = allSongs.length;
  cloneLogPush(`audio: ${allSongs.length} song(s) to fetch`);

  await mapConcurrent(allSongs, CLONE_AUDIO_CONCURRENCY, async (s) => {
    // 159: resume cache — this song's bytes already landed in R2 in a
    // previous run of this same upstream URL, skip re-fetching/re-uploading.
    if (s.id && cloneCache.audioDone.has(s.id)) {
      stage.done++;
      return;
    }
    const filename = `${sanitizePathPart(s.title, "track")}.${s.suffix}`;
    const artistDir = sanitizePathPart(s.artist, "Unknown Artist");
    const albumDir = sanitizePathPart(s.album, "Unknown Album");
    // Derive the masterId consistently with normalizeSongNode so the
    // backend's FK lookup matches the row inserted in stage 1. We use
    // the upstream album id directly when present — upsertMaster stored
    // under that same albumId.
    const realAlbumId = s.albumId || ("al-" + simpleHash(s.artist + " " + s.album));
    const realMasterId = s.id || ("sm-clone-" + simpleHash(s.artist + s.title + realAlbumId));

    if (cloneAudioMode.value === "worker") {
      // Server-side path: the Worker fetches the upstream bytes itself and
      // writes straight to R2 — no bytes ever pass through this browser.
      try {
        const data = JSON.parse(await edgesonicPost("clone/fetchAudioToR2", {
          upstreamUrl: cloneForm.value.url,
          username: cloneForm.value.username,
          password: cloneForm.value.password,
          songId: s.id,
          masterId: realMasterId,
          sourceKey: cloneSourceKey(),
          suffix: s.suffix,
          contentType: s.contentType,
          artist: artistDir,
          album: albumDir,
          filename,
          originalPath: s.path,
          size: s.size,
        }));
        if (!data.ok) throw new Error(data.error || "fetchAudioToR2 rejected");
        stage.done++;
        if (s.id) { cloneCache.audioDone.add(s.id); markCloneCacheDirty(); }
        cloneLogPush(`audio: ✓ ${s.artist} — ${s.title} (${fmtBytes(data.size || s.size || 0)}, worker)`);
      } catch (e: unknown) {
        stage.failed++;
        cloneLogPush(`audio: ✗ ${s.artist} — ${s.title} — ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    // Browser path (default, more stable on flaky upstreams): fetch the
    // bytes here, then re-upload to ingestAudio.
    try {
      const streamUrl = cloneUpstreamUrl("stream", { id: s.id });
      const resp = cloneProxyEnabled.value
        ? await fetch("/edgesonic/clone/proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              upstreamUrl: cloneForm.value.url,
              username: cloneForm.value.username,
              password: cloneForm.value.password,
              path: "stream",
              params: { id: s.id },
              binary: true,
            }),
          })
        : await fetch(streamUrl);
      if (!resp.ok) throw new Error(`stream ${resp.status}`);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength === 0) throw new Error("empty body");
      const qs = new URLSearchParams({
        masterId: realMasterId,
        sourceKey: cloneSourceKey(),
        suffix: s.suffix,
        contentType: s.contentType,
        artist: artistDir,
        album: albumDir,
        filename,
        originalPath: s.path,
        size: String(s.size || buf.byteLength),
      });
      // Reuse the session-signed edgesonicPost path but with a binary body.
      // edgesonicPost builds JSON; we need a raw PUT here, so sign manually.
      const sp = signedParamsCloneEdge();
      const uploadResp = await fetch(`${EDGESONIC_CLONE_BASE}/clone/ingestAudio?${sp.toString()}&${qs.toString()}`, {
        method: "POST",
        headers: { "Content-Type": s.contentType },
        body: buf,
      });
      const data = await uploadResp.json().catch(() => ({ ok: false, error: "non-json" }));
      if (!data.ok) throw new Error(data.error || "ingestAudio rejected");
      stage.done++;
      if (s.id) { cloneCache.audioDone.add(s.id); markCloneCacheDirty(); }
      cloneLogPush(`audio: ✓ ${s.artist} — ${s.title} (${fmtBytes(buf.byteLength)})`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`audio: ✗ ${s.artist} — ${s.title} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }, () => cloneCancelRequested.value);
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
}

// The clone endpoints live under /edgesonic/*, so they need the same
// session-signed query string as edgesonicPost. We can't call the closure
// inside useAuth from here, but useAuth() already returns signedParams().
// To keep this self-contained, sign against the same auth singleton.
function signedParamsCloneEdge(): URLSearchParams {
  // useAuth() exposes signedParams; we just re-import it here.
  return signedParams();
}

const EDGESONIC_CLONE_BASE = "/edgesonic";

function suffixToMime(suffix: string): string {
  switch (suffix.toLowerCase()) {
    case "mp3":  return "audio/mpeg";
    case "m4a":  return "audio/mp4";
    case "aac":  return "audio/aac";
    case "opus": return "audio/opus";
    case "ogg":  return "audio/ogg";
    case "flac": return "audio/flac";
    case "wav":  return "audio/wav";
    default:     return "application/octet-stream";
  }
}

// Stage 3 — playlists.
async function clonePlaylistsStage() {
  const stage = cloneStages.value.playlists;
  stage.status = "running";
  const resp = await cloneFetchJson("getPlaylists");
  let playlists: any[] = [];
  if (resp?._xml) {
    playlists = parseXmlChildren(resp._xml, "playlist");
  } else {
    const raw = resp?.playlists?.playlist || [];
    playlists = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  }
  stage.total = playlists.length;
  cloneLogPush(`playlists: ${playlists.length} playlist(s)`);

  for (const p of playlists) {
    if (cloneCancelRequested.value) break;
    try {
      const id = jget(p, "id") || "";
      const name = jget(p, "name") || "Untitled";
      const owner = jget(p, "owner") || cloneForm.value.username;
      const isPublic = jget(p, "public") === "true";
      const comment = jget(p, "comment") || null;
      // Fetch the full playlist to get entry ids.
      const detail = await cloneFetchJson("getPlaylist", { id });
      let entries: string[] = [];
      if (detail?._xml) {
        const songs = parseXmlChildren(detail._xml, "entry");
        entries = songs.map((s) => s.id).filter(Boolean);
      } else {
        const raw = detail?.playlist?.entry || detail?.entries?.entry || [];
        const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        entries = arr.map((s) => jget(s, "id") || "").filter(Boolean);
      }
      const data = JSON.parse(await edgesonicPost("clone/upsertPlaylist", {
        playlist: { id, name, owner, public: isPublic, comment },
        entries,
        sourceKey: cloneSourceKey(),
      }));
      if (!data.ok) throw new Error(data.error || "upsertPlaylist rejected");
      stage.done++;
      cloneLogPush(`playlists: ✓ ${name} (${entries.length} entries)`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`playlists: ✗ ${jget(p, "name") || "?"} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
}

// Stage 4 — starred.
async function cloneStarredStage() {
  const stage = cloneStages.value.starred;
  stage.status = "running";
  const resp = await cloneFetchJson("getStarred2");
  const items: Array<{ id: string; type: "song" | "album" | "artist"; starredAt?: number | null }> = [];
  if (resp?._xml) {
    for (const s of parseXmlChildren(resp._xml, "song")) items.push({ id: s.id, type: "song" });
    for (const a of parseXmlChildren(resp._xml, "album")) items.push({ id: a.id, type: "album" });
    for (const ar of parseXmlChildren(resp._xml, "artist")) items.push({ id: ar.id, type: "artist" });
  } else {
    const sr = resp?.starred2 || resp?.starred || {};
    for (const bucket of ["song", "album", "artist"] as const) {
      const raw = sr[bucket] || [];
      const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      for (const n of arr) {
        const id = jget(n, "id");
        if (id) items.push({ id, type: bucket });
      }
    }
  }
  stage.total = items.length;
  cloneLogPush(`starred: ${items.length} item(s)`);

  if (items.length > 0) {
    try {
      const data = JSON.parse(await edgesonicPost("clone/upsertStarred", {
        userId: cloneForm.value.username,
        items,
        sourceKey: cloneSourceKey(),
      }));
      if (!data.ok) throw new Error(data.error || "upsertStarred rejected");
      stage.done = items.length;
      cloneLogPush(`starred: ✓ ${items.length} applied`);
    } catch (e: unknown) {
      stage.failed = items.length;
      stage.status = "error";
      stage.message = e instanceof Error ? e.message : String(e);
      cloneLogPush(`starred: ✗ ${stage.message}`);
      return;
    }
  }
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
}

// Stage 5 — users (requires upstream admin).
// 163: a cloned user account used to mean just the login — their own
// starred items and owned playlists never came along, since getStarred2 has
// no "give me user X's stars" param for a regular client and getPlaylists'
// admin-visibility into other users' playlists isn't guaranteed by every
// server. The only universal way to see another user's personal data is to
// actually authenticate as them — which upstream getUsers's password field
// (the same one that unlocks the account clone at all) already lets us do.
async function cloneUserStarredAndPlaylists(username: string, password: string): Promise<void> {
  try {
    const resp = await cloneFetchJsonAs(username, password, "getStarred2");
    const items: Array<{ id: string; type: "song" | "album" | "artist" }> = [];
    if (resp?._xml) {
      for (const s of parseXmlChildren(resp._xml, "song")) items.push({ id: s.id, type: "song" });
      for (const a of parseXmlChildren(resp._xml, "album")) items.push({ id: a.id, type: "album" });
      for (const ar of parseXmlChildren(resp._xml, "artist")) items.push({ id: ar.id, type: "artist" });
    } else {
      const sr = resp?.starred2 || resp?.starred || {};
      for (const bucket of ["song", "album", "artist"] as const) {
        const raw = sr[bucket] || [];
        const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        for (const n of arr) {
          const id = jget(n, "id");
          if (id) items.push({ id, type: bucket });
        }
      }
    }
    if (items.length > 0) {
      const data = JSON.parse(await edgesonicPost("clone/upsertStarred", { userId: username, items, sourceKey: cloneSourceKey() }));
      if (!data.ok) throw new Error(data.error || "upsertStarred rejected");
      cloneLogPush(`users: ✓ ${username} — ${items.length} starred item(s)`);
    }
  } catch (e: unknown) {
    cloneLogPush(`users: ✗ ${username} (starred) — ${e instanceof Error ? e.message : String(e)}`);
  }

  // Only playlists this user actually owns — a public playlist owned by
  // someone else but visible to them would otherwise get reprocessed once
  // per user who can see it; it gets handled on its real owner's own turn
  // through this same loop instead.
  try {
    const resp = await cloneFetchJsonAs(username, password, "getPlaylists");
    let playlists: any[] = [];
    if (resp?._xml) {
      playlists = parseXmlChildren(resp._xml, "playlist");
    } else {
      const raw = resp?.playlists?.playlist || [];
      playlists = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    }
    let count = 0;
    for (const p of playlists) {
      if (cloneCancelRequested.value) break;
      const owner = jget(p, "owner") || username;
      if (owner !== username) continue;
      const id = jget(p, "id") || "";
      const name = jget(p, "name") || "Untitled";
      const isPublic = jget(p, "public") === "true";
      const comment = jget(p, "comment") || null;
      const detail = await cloneFetchJsonAs(username, password, "getPlaylist", { id });
      let entries: string[] = [];
      if (detail?._xml) {
        const songs = parseXmlChildren(detail._xml, "entry");
        entries = songs.map((s) => s.id).filter(Boolean);
      } else {
        const raw = detail?.playlist?.entry || detail?.entries?.entry || [];
        const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        entries = arr.map((s) => jget(s, "id") || "").filter(Boolean);
      }
      const data = JSON.parse(await edgesonicPost("clone/upsertPlaylist", {
        playlist: { id, name, owner, public: isPublic, comment },
        entries,
        sourceKey: cloneSourceKey(),
      }));
      if (!data.ok) throw new Error(data.error || "upsertPlaylist rejected");
      count++;
    }
    if (count > 0) cloneLogPush(`users: ✓ ${username} — ${count} playlist(s)`);
  } catch (e: unknown) {
    cloneLogPush(`users: ✗ ${username} (playlists) — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function cloneUsersStage() {
  const stage = cloneStages.value.users;
  if (!cloneUsersEnabled.value) {
    stage.status = "skipped";
    stage.message = "disabled";
    return;
  }
  stage.status = "running";
  const resp = await cloneFetchJson("getUsers");
  let users: any[] = [];
  if (resp?._xml) {
    users = parseXmlChildren(resp._xml, "user");
  } else {
    const raw = resp?.users?.user || [];
    users = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  }
  stage.total = users.length;
  cloneLogPush(`users: ${users.length} user(s)`);

  for (const u of users) {
    if (cloneCancelRequested.value) break;
    try {
      const username = jget(u, "username") || "";
      const password = jget(u, "password") || "";
      const level = (jget(u, "adminRole") === "true" || jget(u, "isAdmin") === "true") ? 3 : 1;
      const enabled = jget(u, "disabled") !== "true";
      if (!username || !password) {
        stage.failed++;
        cloneLogPush(`users: ✗ ${username || "?"} — missing username/password (upstream must expose password)`);
        continue;
      }
      const data = JSON.parse(await edgesonicPost("clone/upsertUser", {
        user: { username, password, level, enabled },
        credentials: [{ password, label: "cloned" }],
      }));
      if (!data.ok) throw new Error(data.error || "upsertUser rejected");
      stage.done++;
      cloneLogPush(`users: ✓ ${username}`);
      // clonePlaylistsStage/cloneStarredStage above only ever cover the
      // single admin identity used to authenticate this whole run — skip
      // it here so its starred/playlists don't get pulled (and upserted)
      // twice.
      if (username !== cloneForm.value.username && !cloneCancelRequested.value) {
        await cloneUserStarredAndPlaylists(username, password);
      }
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`users: ✗ ${jget(u, "username") || "?"} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = cloneCancelRequested.value ? "skipped" : "done";
}

async function runClone() {
  if (!isSuperAdmin.value || cloneRunning.value) return;
  if (!cloneForm.value.url || !cloneForm.value.username || !cloneForm.value.password) {
    showToast(t("settings.common.clone.missingFields"), "error");
    return;
  }
  cloneRunning.value = true;
  cloneCancelRequested.value = false;
  cloneLog.value = [];
  cloneFilterSongIds.value = null;
  // 159: reload from localStorage (not just reuse the module-level var) in
  // case the URL field changed since last load — cache is scoped per URL.
  cloneCache = loadCloneCache();
  if (cloneCache.metadataDone.size || cloneCache.audioDone.size) {
    cloneLogPush(`resume: ${cloneCache.metadataDone.size} metadata + ${cloneCache.audioDone.size} audio item(s) cached from a previous run, will be skipped`);
  }
  for (const k of Object.keys(cloneStages.value) as Array<keyof typeof cloneStages.value>) {
    cloneStages.value[k] = newCloneProgress();
  }
  try {
    cloneFilterSongIds.value = await buildCloneFilterSet();
    if (cloneFilterSongIds.value) {
      cloneLogPush(`filter: enabled, ${cloneFilterSongIds.value.size} song id(s) allowed by playlists/starred rules`);
    }
    await cloneMetadataStage();
    await cloneAudioStage();
    await clonePlaylistsStage();
    await cloneStarredStage();
    await cloneUsersStage();
    showToast(t("settings.common.clone.done"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.clone.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  // Flush whatever the debounce timer hasn't written yet — matters most on
  // cancel/error, where the run stops well before the 1s debounce would.
  saveCloneCacheNow();
  cloneRunning.value = false;
}

function cancelClone() {
  cloneCancelRequested.value = true;
}

// The reverse direction of the 094 clone, same browser-driven shape and same
// upstream credential form. Local song ids mean nothing upstream, so each
// song is matched via upstream search3 using a *cleaned* title (leading track
// numbers like "01." / "01 - " / "#1 " stripped), and only written when the
// combined title/artist/duration confidence clears a threshold — a wrong
// star/playlist entry on the upstream is worse than a skipped one.
const pushRunning = ref(false);
const pushCancelRequested = ref(false);
const pushStages = ref({
  starred: newCloneProgress(),
  playlists: newCloneProgress(),
});
// title|artist → matched upstream id (or null after a failed search), so the
// starred pass and every playlist share one search per distinct song.
const pushMatchCache = new Map<string, string | null>();

function scorePushCandidate(
  local: { titleN: string; artistN: string; duration: number | null },
  cand: any,
): number {
  const ct = normalizeForMatch(jget(cand, "title"));
  const ca = normalizeForMatch(jget(cand, "artist"));
  const cd = parseInt(jget(cand, "duration") || "", 10);
  if (!ct || !local.titleN) return 0;
  let score = 0;
  if (ct === local.titleN) score += 0.6;
  else if (ct.includes(local.titleN) || local.titleN.includes(ct)) score += 0.35;
  else return 0; // title is mandatory — artist/duration alone never qualify
  if (local.artistN && ca) {
    if (ca === local.artistN) score += 0.25;
    else if (ca.includes(local.artistN) || local.artistN.includes(ca)) score += 0.12;
  }
  if (local.duration !== null && Number.isFinite(cd) && Math.abs(cd - local.duration) <= 3) score += 0.15;
  return score;
}

const PUSH_MATCH_THRESHOLD = 0.75;

async function matchUpstreamSong(
  title: string | undefined,
  artist: string | undefined,
  duration: number | null,
): Promise<{ id: string; score: number } | null> {
  const titleN = normalizeForMatch(title);
  if (!titleN) return null;
  const artistN = normalizeForMatch(artist);
  const cacheKey = `${titleN}|${artistN}`;
  if (pushMatchCache.has(cacheKey)) {
    const cached = pushMatchCache.get(cacheKey);
    return cached ? { id: cached, score: 1 } : null;
  }
  const resp = await cloneFetchJson("search3", {
    query: titleN, songCount: "10", albumCount: "0", artistCount: "0",
  });
  let cands: any[] = [];
  if (resp?._xml) {
    cands = parseXmlChildren(resp._xml, "song");
  } else {
    const raw = resp?.searchResult3?.song || [];
    cands = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  }
  let best: any = null;
  let bestScore = 0;
  for (const cand of cands) {
    const sc = scorePushCandidate({ titleN, artistN, duration }, cand);
    if (sc > bestScore) { bestScore = sc; best = cand; }
  }
  const id = bestScore >= PUSH_MATCH_THRESHOLD ? (jget(best, "id") || null) : null;
  pushMatchCache.set(cacheKey, id);
  return id ? { id, score: bestScore } : null;
}

// Local /rest reads (session-signed). EdgeSonic answers XML; the attribute
// parser above handles it.
async function localFetchXml(path: string, params?: Record<string, string>): Promise<string> {
  const resp = await fetch(restUrl(path, params));
  return resp.text();
}

function upstreamOk(resp: any): boolean {
  if (resp?._xml) return /status="ok"/.test(resp._xml);
  return resp?.status === "ok";
}

// createPlaylist needs repeated songId params, which the Record-based helper
// can't express — build the query directly.
async function upstreamCreatePlaylist(name: string, songIds: string[]): Promise<boolean> {
  const sp = cloneSignedParams({ name });
  for (const id of songIds) sp.append("songId", id);
  const base = cloneForm.value.url.replace(/\/+$/, "");
  const resp = await fetch(`${base}/rest/createPlaylist?${sp.toString()}`);
  const text = await resp.text();
  try {
    const json = JSON.parse(text);
    return (json?.["subsonic-response"] ?? json)?.status === "ok";
  } catch {
    return /status="ok"/.test(text);
  }
}

async function pushStarredStage() {
  const stage = pushStages.value.starred;
  stage.status = "running";
  const xml = await localFetchXml("getStarred2");
  const songs = parseXmlChildren(xml, "song");
  stage.total = songs.length;
  cloneLogPush(`push starred: ${songs.length} local starred song(s)`);
  for (const s of songs) {
    if (pushCancelRequested.value) break;
    try {
      const m = await matchUpstreamSong(s.title, s.artist, numOr(s.duration, null));
      if (!m) {
        stage.failed++;
        cloneLogPush(`push starred: ？ no confident match — ${s.artist || "?"} — ${s.title || "?"}`);
        continue;
      }
      const resp = await cloneFetchJson("star", { id: m.id });
      if (!upstreamOk(resp)) throw new Error("upstream star rejected");
      stage.done++;
      cloneLogPush(`push starred: ✓ ${s.title} → ${m.id}`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`push starred: ✗ ${s.title || "?"} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = pushCancelRequested.value ? "skipped" : "done";
}

async function pushPlaylistsStage() {
  const stage = pushStages.value.playlists;
  stage.status = "running";

  // Same-name playlists upstream are skipped, not merged — merging would need
  // a diff against upstream entries and risks clobbering someone's edits.
  const upResp = await cloneFetchJson("getPlaylists");
  let upNames: string[] = [];
  if (upResp?._xml) {
    upNames = parseXmlChildren(upResp._xml, "playlist").map((p) => p.name || "");
  } else {
    const raw = upResp?.playlists?.playlist || [];
    const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    upNames = arr.map((p: any) => jget(p, "name") || "");
  }
  const existing = new Set(upNames.map((n) => n.toLowerCase()).filter(Boolean));

  const xml = await localFetchXml("getPlaylists");
  const playlists = parseXmlChildren(xml, "playlist");
  stage.total = playlists.length;
  cloneLogPush(`push playlists: ${playlists.length} local playlist(s)`);

  for (const p of playlists) {
    if (pushCancelRequested.value) break;
    const name = p.name || "Untitled";
    try {
      if (existing.has(name.toLowerCase())) {
        stage.done++;
        cloneLogPush(`push playlists: → ${name} already exists upstream, skipped`);
        continue;
      }
      const detailXml = await localFetchXml("getPlaylist", { id: p.id });
      const entries = parseXmlChildren(detailXml, "entry");
      const ids: string[] = [];
      let missed = 0;
      for (const e of entries) {
        if (pushCancelRequested.value) break;
        const m = await matchUpstreamSong(e.title, e.artist, numOr(e.duration, null));
        if (m) ids.push(m.id);
        else {
          missed++;
          cloneLogPush(`push playlists: ？ ${name}: no match — ${e.artist || "?"} — ${e.title || "?"}`);
        }
      }
      if (pushCancelRequested.value) break;
      if (ids.length === 0) {
        stage.failed++;
        cloneLogPush(`push playlists: ✗ ${name} — 0/${entries.length} matched, not created`);
        continue;
      }
      if (!(await upstreamCreatePlaylist(name, ids))) throw new Error("upstream createPlaylist rejected");
      stage.done++;
      cloneLogPush(`push playlists: ✓ ${name} (${ids.length}/${entries.length} matched${missed ? `, ${missed} missed` : ""})`);
    } catch (e: unknown) {
      stage.failed++;
      cloneLogPush(`push playlists: ✗ ${name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stage.status = pushCancelRequested.value ? "skipped" : "done";
}

async function runPush() {
  if (!isSuperAdmin.value || pushRunning.value || cloneRunning.value) return;
  if (!cloneForm.value.url || !cloneForm.value.username || !cloneForm.value.password) {
    showToast(t("settings.common.clone.missingFields"), "error");
    return;
  }
  pushRunning.value = true;
  pushCancelRequested.value = false;
  pushMatchCache.clear();
  for (const k of Object.keys(pushStages.value) as Array<keyof typeof pushStages.value>) {
    pushStages.value[k] = newCloneProgress();
  }
  try {
    await pushStarredStage();
    await pushPlaylistsStage();
    showToast(t("settings.common.clone.done"));
  } catch (e: unknown) {
    showToast(`${t("settings.common.clone.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  pushRunning.value = false;
}

function cancelPush() {
  pushCancelRequested.value = true;
}

function cloneStatusClass(status: CloneProgress["status"]): string {
  switch (status) {
    case "running": return "info";
    case "done":    return "success";
    case "error":   return "error";
    case "skipped": return "muted";
    default:        return "muted";
  }
}
</script>

<template>
  <div class="tools">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("tools.label") }}</div>
        <h1 class="page-title">{{ t("tools.title") }}</h1>
      </div>
    </div>

    <div v-if="!isSuperAdmin" class="empty-state">
      <div class="empty-state-icon">⚿</div>
      <div>{{ t("tools.superAdminOnly") }}</div>
    </div>

    <template v-else>
      <!-- Sections mirror Settings.vue's .settings-section pattern
           (button header + v-show body, no transition) instead of the
           bespoke .tools-accordion this page used to have. -->

      <!-- ============ SUBSONIC 迁移工具（克隆 + 推送，中间切换） ============ -->
      <section class="settings-section card" :class="{ open: open.migrate }">
        <button class="section-header" @click="toggleSection('migrate')">
          <span class="section-title">SUBSONIC 迁移工具</span>
          <span class="section-caret">{{ open.migrate ? '−' : '+' }}</span>
        </button>
        <div v-show="open.migrate" class="section-body">
          <div class="seg">
            <button type="button" :class="['seg-btn', { active: migrateMode === 'clone' }]" @click="migrateMode = 'clone'">克隆（拉取）</button>
            <button type="button" :class="['seg-btn', { active: migrateMode === 'push' }]" @click="migrateMode = 'push'">推送（写回）</button>
          </div>

          <!-- Shared upstream credentials — both directions talk to the same server -->
          <div class="sub-block">
            <div class="sub-header"><span class="mono-label">上游服务器</span></div>
            <div class="transcode-grid">
              <label class="tc-row">
                <span class="tc-key">{{ t("settings.common.clone.url") }}</span>
                <input
                  v-model="cloneForm.url"
                  class="form-input"
                  :placeholder="t('settings.common.clone.urlPlaceholder')"
                  :disabled="cloneRunning || pushRunning"
                  autocomplete="off"
                />
              </label>
              <p class="feature-desc tc-desc">{{ t("settings.common.clone.urlDesc") }}</p>

              <label class="tc-row">
                <span class="tc-key">{{ t("settings.common.clone.username") }}</span>
                <input
                  v-model="cloneForm.username"
                  class="form-input"
                  :placeholder="t('settings.common.clone.usernamePlaceholder')"
                  :disabled="cloneRunning || pushRunning"
                  autocomplete="off"
                />
              </label>

              <label class="tc-row">
                <span class="tc-key">{{ t("settings.common.clone.password") }}</span>
                <input
                  v-model="cloneForm.password"
                  type="password"
                  class="form-input"
                  :placeholder="t('settings.common.clone.passwordPlaceholder')"
                  :disabled="cloneRunning || pushRunning"
                  autocomplete="off"
                />
              </label>

              <label class="tc-row">
                <input type="checkbox" v-model="cloneProxyEnabled" />
                <span class="tc-key">使用 Worker 代理（防止 CORS）</span>
              </label>
              <p class="feature-desc tc-desc" style="margin-left:0">开启后，所有上游 Subsonic 读取（歌单/收藏/元数据/音频）都经 EdgeSonic Worker 转发，适用于源站未配置 CORS 的场景。</p>
            </div>
          </div>

          <!-- Clone (pull) -->
          <div v-if="migrateMode === 'clone'" class="sub-block">
            <p class="feature-desc" style="margin: 0 0 0.6rem 0">
              {{ t("settings.common.clone.desc") }}
            </p>
            <div class="clone-options">
              <label class="tc-row">
                <input type="checkbox" v-model="clonePlaylistOnly" />
                <span class="tc-key">仅克隆处于歌单的歌曲</span>
              </label>
              <label class="tc-row">
                <input type="checkbox" v-model="cloneStarredOnly" />
                <span class="tc-key">仅克隆收藏的歌曲</span>
              </label>
              <p class="feature-desc tc-desc" style="margin-left:0">上面两个过滤条件是并集关系：勾选任一项即纳入；两项都勾选时，克隆“歌单中的歌曲 ∪ 收藏的歌曲”。</p>
            </div>
            <div class="transcode-grid">
              <label class="tc-row">
                <span class="tc-key">{{ t("settings.common.clone.metadataToggle") }}</span>
                <span class="scan-toggle">
                  <input type="checkbox" v-model="cloneMetadataEnabled" :disabled="cloneRunning" />
                  <span>{{ cloneMetadataEnabled ? t("common.on") : t("common.off") }}</span>
                </span>
              </label>
              <p class="feature-desc tc-desc">{{ t("settings.common.clone.metadataToggleDesc") }}</p>

              <label class="tc-row">
                <span class="tc-key">{{ t("settings.common.clone.audioToggle") }}</span>
                <span class="scan-toggle">
                  <input type="checkbox" v-model="cloneAudioEnabled" :disabled="cloneRunning" />
                  <span>{{ cloneAudioEnabled ? t("common.on") : t("common.off") }}</span>
                </span>
              </label>
              <p class="feature-desc tc-desc">{{ t("settings.common.clone.audioToggleDesc") }}</p>

              <label v-if="cloneAudioEnabled" class="tc-row">
                <span class="tc-key">{{ t("settings.common.clone.audioMode") }}</span>
                <span class="seg">
                  <button type="button" :class="['seg-btn', { active: cloneAudioMode === 'browser' }]" :disabled="cloneRunning" @click="cloneAudioMode = 'browser'">
                    {{ t("settings.common.clone.audioModeBrowser") }}
                  </button>
                  <button type="button" :class="['seg-btn', { active: cloneAudioMode === 'worker' }]" :disabled="cloneRunning" @click="cloneAudioMode = 'worker'">
                    {{ t("settings.common.clone.audioModeWorker") }}
                  </button>
                </span>
              </label>
              <p v-if="cloneAudioEnabled" class="feature-desc tc-desc">
                {{ cloneAudioMode === "worker" ? t("settings.common.clone.audioModeWorkerDesc") : t("settings.common.clone.audioModeBrowserDesc") }}
              </p>

              <label class="tc-row">
                <span class="tc-key">{{ t("settings.common.clone.usersToggle") }}</span>
                <span class="scan-toggle">
                  <input type="checkbox" v-model="cloneUsersEnabled" :disabled="cloneRunning" />
                  <span>{{ cloneUsersEnabled ? t("common.on") : t("common.off") }}</span>
                </span>
              </label>
              <p class="feature-desc tc-desc">{{ t("settings.common.clone.usersToggleDesc") }}</p>

              <p v-if="!cloneRunning && cloneForm.url && (cloneCacheCounts.metadata || cloneCacheCounts.audio)" class="feature-desc tc-desc">
                {{ t("settings.common.clone.cacheHint", { metadata: cloneCacheCounts.metadata, audio: cloneCacheCounts.audio }) }}
              </p>

              <div class="tc-actions">
                <button
                  v-if="!cloneRunning && cloneForm.url && (cloneCacheCounts.metadata || cloneCacheCounts.audio)"
                  type="button"
                  class="btn-secondary"
                  @click="clearCloneCache"
                >{{ t("settings.common.clone.clearCache") }}</button>
                <button v-if="!cloneRunning" class="btn-primary" :disabled="pushRunning" @click="runClone">
                  {{ t("settings.common.clone.start") }}
                </button>
                <button v-else class="btn-danger" @click="cancelClone">
                  {{ t("settings.common.clone.cancel") }}
                </button>
              </div>
            </div>

            <div v-if="cloneRunning || cloneStages.metadata.status !== 'idle'" class="clone-progress">
              <div v-for="key in (['metadata', 'audio', 'playlists', 'starred', 'users'] as const)" :key="key" class="clone-stage-row">
                <span class="clone-stage-label">{{ t(`settings.common.clone.stages.${key}`) }}</span>
                <span class="clone-stage-count">{{ cloneStages[key].done }} / {{ cloneStages[key].total }}</span>
                <span v-if="cloneStages[key].failed" class="clone-stage-failed">✗ {{ cloneStages[key].failed }}</span>
                <span class="status-badge" :class="cloneStatusClass(cloneStages[key].status)">
                  {{ t(`settings.common.clone.status.${cloneStages[key].status}`) }}
                </span>
              </div>
            </div>
          </div>

          <!-- Push (write back) -->
          <div v-else class="sub-block">
            <p class="feature-desc" style="margin: 0 0 0.6rem 0">
              {{ t("settings.common.clone.push.desc") }}
            </p>
            <div class="tc-actions">
              <button v-if="!pushRunning" class="btn-primary" :disabled="cloneRunning" @click="runPush">
                {{ t("settings.common.clone.push.start") }}
              </button>
              <button v-else class="btn-danger" @click="cancelPush">
                {{ t("settings.common.clone.cancel") }}
              </button>
            </div>
            <div v-if="pushRunning || pushStages.starred.status !== 'idle'" class="clone-progress">
              <div v-for="key in (['starred', 'playlists'] as const)" :key="key" class="clone-stage-row">
                <span class="clone-stage-label">{{ t(`settings.common.clone.push.${key}`) }}</span>
                <span class="clone-stage-count">{{ pushStages[key].done }} / {{ pushStages[key].total }}</span>
                <span v-if="pushStages[key].failed" class="clone-stage-failed">✗ {{ pushStages[key].failed }}</span>
                <span class="status-badge" :class="cloneStatusClass(pushStages[key].status)">
                  {{ t(`settings.common.clone.status.${pushStages[key].status}`) }}
                </span>
              </div>
            </div>
          </div>

          <!-- Shared live log — both directions write into the same cloneLog -->
          <details v-if="cloneLog.length" class="clone-log sub-block" open>
            <summary class="mono-label">{{ t("settings.common.clone.log") }}</summary>
            <pre class="clone-log-pre">{{ cloneLog.join("\n") }}</pre>
          </details>
        </div>
      </section>

      <!-- ============ 工作池 ============ -->
      <section class="settings-section card" :class="{ open: open.workPool }">
        <button class="section-header" @click="toggleSection('workPool')">
          <span class="section-title">WORKER 预解析</span>
          <span class="section-caret">{{ open.workPool ? '−' : '+' }}</span>
        </button>
        <div v-show="open.workPool" class="section-body">
      <!-- Work pool card -->
      <div class="card tools-work-pool-card">
        <div class="card-header">
          <span class="card-title">Worker 预解析</span>
          <div class="wp-header-actions">
            <span v-if="workerPool.isWorking" class="wp-auto-status wp-auto-status-running">运行中</span>
            <span v-else-if="autoStartCountdownText" class="wp-auto-status">{{ autoStartCountdownText }} 后自动启动</span>
            <button class="wp-refresh" :disabled="workerPool.isWorking" @click="workerPool.pollNow()">立即开始</button>
          </div>
        </div>
        <div class="wp-progress-line">
          <span class="wp-progress-label">解析进度</span>
          <span class="wp-progress-num">{{ workCounts.completed }} / {{ totalTasks }} ({{ progressPct }}%)</span>
        </div>
        <div class="wp-progress-bar">
          <div class="wp-progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
        <!-- Real-time: which song this browser is parsing right now. -->
        <div v-if="workerPool.stats.currentFileName" class="wp-current-song mono-label">
          <span class="wp-current-dot" aria-hidden="true"></span>
          正在解析：{{ workerPool.stats.currentFileName }}
        </div>
        <div class="wp-counts">
          <div class="wp-count"><span class="wp-count-label">队列</span><span class="wp-count-num">{{ workCounts.queued }}</span></div>
          <div class="wp-count"><span class="wp-count-label">进行中</span><span class="wp-count-num">{{ workCounts.claimed }}</span></div>
          <div class="wp-count"><span class="wp-count-label">完成</span><span class="wp-count-num">{{ workCounts.completed }}</span></div>
          <div class="wp-count" :class="{ 'wp-count-emphasis': workCounts.failed > 0 }"><span class="wp-count-label">失败</span><span class="wp-count-num">{{ workCounts.failed }}</span></div>
        </div>
        <div class="wp-speed-row">
          <div class="wp-speed-item">
            <span class="wp-count-label">本机速度</span>
            <span class="wp-count-num">{{ workerPool.speedPerMin === null ? '—' : `${workerPool.speedPerMin}/分钟` }}</span>
          </div>
          <div class="wp-speed-item">
            <span class="wp-count-label">总速度</span>
            <span class="wp-count-num">{{ globalSpeedPerMin === null ? '—' : `${globalSpeedPerMin}/分钟` }}</span>
          </div>
          <div class="wp-speed-item">
            <span class="wp-count-label">预计剩余</span>
            <span class="wp-count-num">{{ etaText }}</span>
          </div>
        </div>
        <div class="wp-workers">
          <div class="wp-workers-title">活跃浏览器 worker</div>
          <div v-if="workLoad.length === 0" class="wp-workers-empty">无浏览器在线</div>
          <ul v-else class="wp-workers-list">
            <li v-for="row in workLoad" :key="row.username" class="wp-worker-row">
              <span class="wp-worker-name">{{ row.username }}</span>
              <span class="wp-worker-load">{{ row.n }} 个任务</span>
            </li>
          </ul>
        </div>
        <div v-if="workCounts.failed > 0 || workCounts.claimed > 0" class="wp-actions">
          <button v-if="workCounts.failed > 0" class="btn-secondary btn-sm" @click="onResetFailedWork()">重启失败</button>
          <button v-if="workCounts.claimed > 0" class="btn-secondary btn-sm" @click="onReclaimStaleWork()">回收超时</button>
        </div>

        <!-- 本机设置：参与开关、本机统计、能力、并发度——原先分散在设置页，
             现在集中到这里（同一台浏览器的运行参数）。 -->
        <div class="wp-worker-toggle">
          <label class="wp-toggle-label">
            <input type="checkbox" :checked="workerPool.enabled" :disabled="!workerPool.eligible" @change="workerPool.setEnabled(($event.target as HTMLInputElement).checked)" />
            <span>浏览器 Worker: {{ workerPool.enabled ? '已启用' : '已禁用' }}</span>
          </label>
          <p v-if="!workerPool.eligible" class="wp-ineligible-hint">当前等级不可参与浏览器预解析（需要等级 ≥ 2）</p>
        </div>
        <div class="wp-local-stats">
          <span class="wp-count-label">本机统计</span>
          <span class="wp-local-stat wp-local-stat-ok">成功 {{ workerPool.stats.completed }}</span>
          <span class="wp-local-stat wp-local-stat-fail">失败 {{ workerPool.stats.failed }}</span>
        </div>
        <div class="wp-caps">
          <span class="wp-count-label">当前能力</span>
          <span v-for="cap in workerPool.caps" :key="cap" class="wp-cap-pill">{{ cap }}</span>
          <span v-if="workerPool.caps.length === 0" class="text-muted">—</span>
        </div>
        <div class="wp-concurrency">
          <span class="wp-count-label">并发度</span>
          <input
            type="number" min="1" max="8" step="1"
            v-model.number="maxConcurrentInput"
            class="form-input wp-concurrency-input"
            :disabled="!isSuperAdmin"
          />
          <button class="btn-secondary btn-sm" :disabled="!isSuperAdmin || maxConcurrentBusy" @click="saveMaxConcurrent">保存</button>
          <span class="wp-concurrency-hint">1-8（并发上限）——浏览器会按最近任务成功/失败率，在 1 到此上限之间自动升降实际并发数</span>
          <span class="wp-count-label" style="margin-left: 0.6rem">当前并发 {{ workerPool.currentConcurrency }} / {{ workerPool.maxConcurrent }}</span>
        </div>

        <div v-if="workerPool.lastError" class="wp-last-error">
          <span>⚠</span> <code>{{ workerPool.lastError }}</code>
        </div>
      </div>
        </div>
      </section>

      <!-- ============ 存储与 R2 费用 ============ -->
      <section class="settings-section card" :class="{ open: open.storage }">
        <button class="section-header" @click="toggleSection('storage')">
          <span class="section-title">存储与 R2 费用</span>
          <span class="section-caret">{{ open.storage ? '−' : '+' }}</span>
        </button>
        <div v-show="open.storage" class="section-body">
      <div class="card tools-storage-card">
        <div class="card-header">
          <span class="card-title">存储 & R2 费用</span>
          <button class="wp-refresh" :disabled="storageLoading" @click="loadStorageStats">↻</button>
        </div>
        <div v-if="storageLoading" class="storage-loading">加载中…</div>
        <template v-else-if="storageStats">
          <table class="storage-table">
            <thead><tr><th>存储源</th><th class="num-col">文件数</th><th class="num-col">占用空间</th></tr></thead>
            <tbody>
              <tr v-for="row in storageStats.breakdown" :key="row.source_type">
                <td>{{ row.source_type.toUpperCase() }}</td>
                <td class="num-col">{{ row.count.toLocaleString() }}</td>
                <td class="num-col">{{ fmtBytes(row.bytes) }}</td>
              </tr>
              <tr v-if="storageStats.r2CoverCount > 0">
                <td>R2 封面</td>
                <td class="num-col">{{ storageStats.r2CoverCount }}</td>
                <td class="num-col">{{ fmtBytes(storageStats.r2CoverBytes) }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td><strong>合计</strong></td>
                <td class="num-col"><strong>{{ (storageStats.breakdown.reduce((s, r) => s + r.count, 0) + storageStats.r2CoverCount).toLocaleString() }}</strong></td>
                <td class="num-col"><strong>{{ fmtBytes(storageStats.breakdown.reduce((s, r) => s + r.bytes, 0) + storageStats.r2CoverBytes) }}</strong></td>
              </tr>
            </tfoot>
          </table>
          <div class="cost-rows">
            <div class="cost-row"><span class="cost-label">R2 文件存储</span><span class="cost-value">{{ fmtBytes(r2Row.bytes) }}</span></div>
            <div class="cost-row"><span class="cost-label">R2 封面存储</span><span class="cost-value">{{ fmtBytes(storageStats.r2CoverBytes ?? 0) }}</span></div>
            <div class="cost-row"><span class="cost-label">R2 总用量</span><span class="cost-value" style="font-weight:600">{{ fmtBytes(r2TotalBytes) }}</span></div>
            <div class="cost-row cost-row-input">
              <label class="cost-label">免费额度分配</label>
              <div class="free-alloc-input-row">
                <input v-model.number="freeAllocInput" type="number" min="0" max="10" step="0.5" class="free-alloc-input" />
                <span class="cost-unit">GB</span>
                <button class="btn-sm btn-primary" :disabled="freeAllocSaving" @click="saveFreeAlloc">保存</button>
              </div>
            </div>
            <div class="cost-row"><span class="cost-label">计费用量</span><span class="cost-value">{{ billableGb <= 0 ? '0 GB（免费额内）' : `${billableGb.toFixed(3)} GB` }}</span></div>
            <div class="cost-row cost-total-row"><span class="cost-label">预估月费</span><span class="cost-value cost-total">{{ monthlyCost <= 0 ? '$0.00' : `$${monthlyCost.toFixed(4)}` }}</span></div>
          </div>
        </template>
        <div v-else class="storage-loading muted">暂无数据</div>
      </div>
        </div>
      </section>

      <!-- ============ 孤儿歌曲清理 ============ -->
      <section class="settings-section card" :class="{ open: open.orphanSongs }">
        <button class="section-header" @click="toggleSection('orphanSongs')">
          <span class="section-title">孤儿歌曲清理</span>
          <span class="section-caret">{{ open.orphanSongs ? '−' : '+' }}</span>
        </button>
        <div v-show="open.orphanSongs" class="section-body">
      <div class="card tools-orphan-card">
        <div class="card-header">
          <span class="card-title">未匹配的孤儿歌曲</span>
          <button class="wp-refresh" :disabled="orphanLoading" @click="loadOrphanSongs">↻</button>
        </div>
        <p class="orphan-hint mono-label">
          上传后一直卡在"未知艺术家 / Pending Uploads"、从未被正确识别标签的歌曲。
          文件本身可能只是当时解析失败（可重新扫描），也可能完全没有可用标签（建议直接删除）。
        </p>
        <div v-if="orphanLoading" class="storage-loading">加载中…</div>
        <div v-else-if="orphanSongs.length === 0" class="storage-loading muted">没有发现孤儿歌曲</div>
        <template v-else>
          <div class="orphan-toolbar">
            <label class="wp-toggle-label">
              <input type="checkbox" :checked="orphanAllSelected" @change="toggleOrphanAll" />
              <span>全选（{{ orphanSelected.length }}/{{ orphanSongs.length }}）</span>
            </label>
            <button class="btn-secondary btn-sm" :disabled="!orphanSelected.length || orphanRescanBusy" @click="rescanSelectedOrphans">
              {{ orphanRescanBusy ? "提交中…" : "重新扫描" }}
            </button>
            <button class="btn-secondary btn-sm" :disabled="!orphanSelected.length || orphanDeleteBusy" @click="deleteSelectedOrphans">
              {{ orphanDeleteBusy ? "删除中…" : "删除选中" }}
            </button>
          </div>
          <table class="storage-table orphan-table">
            <thead><tr><th></th><th>标题</th><th class="num-col">大小</th><th>状态</th><th>创建时间</th></tr></thead>
            <tbody>
              <tr v-for="s in orphanSongs" :key="s.masterId">
                <td><input type="checkbox" :checked="orphanSelectedSet.has(s.masterId)" @change="toggleOrphanSelect(s.masterId)" /></td>
                <td>{{ s.title }}<span v-if="s.suffix" class="muted"> .{{ s.suffix }}</span></td>
                <td class="num-col">{{ fmtBytes(s.totalSize) }}</td>
                <td>
                  <span v-if="s.missing" class="status-badge error">文件缺失</span>
                  <span v-else-if="s.tagScanned === 0" class="status-badge info">待扫描</span>
                  <span v-else class="status-badge muted">标签为空</span>
                </td>
                <td class="mono-label">{{ formatOrphanDate(s.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* Sections mirror Settings.vue's .settings-section exactly (same
   markup shape: button.section-header + v-show'd .section-body, no
   collapse transition) so Tools and Settings share one design language
   instead of Tools having its own bespoke accordion. */
.settings-section { padding: 0; margin-bottom: 1.1rem; overflow: hidden; }
.section-header {
  width: 100%;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.95rem 1.2rem;
  background: var(--color-bg-primary);
  border: none;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background 0.15s;
}
.section-header:hover { background: var(--color-bg-tertiary); }
.settings-section.open .section-header { border-bottom: 1px solid var(--color-border-subtle); }
.section-title {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.section-caret {
  font-family: var(--font-mono);
  font-size: 1.1rem;
  color: var(--color-accent-primary);
  width: 20px; text-align: center;
}
.section-body { padding: 1.1rem 1.2rem 1.3rem; }
.sub-block { padding: 0.9rem 0; border-bottom: 1px solid var(--color-border-subtle); }
.sub-block:first-child { padding-top: 0; }
.sub-block:last-child { border-bottom: none; padding-bottom: 0; }

.seg { display: inline-flex; border: 1px solid var(--color-border-subtle); margin-bottom: 1rem; }
.seg-btn {
  background: none; border: none; padding: 0.35rem 0.85rem; cursor: pointer;
  font-family: var(--font-mono); font-size: var(--fs-xs);
  letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--color-text-secondary);
  border-right: 1px solid var(--color-border-subtle);
}
.seg-btn:last-child { border-right: none; }
.seg-btn:hover { color: var(--color-text-primary); }
.seg-btn.active { background: var(--color-accent-dim); color: var(--color-accent-primary); }

.clone-options {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin-bottom: 1rem;
  padding: 0.85rem 0.95rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  background: var(--color-bg-primary);
}

/* Shared with Settings (scoped copies) */
.sub-header { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.6rem; }
.feature-desc { font-size: var(--fs-sm); color: var(--color-text-secondary); }
.transcode-grid { display: flex; flex-direction: column; gap: 0.65rem; }
.tc-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.tc-key {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--color-text-primary);
  min-width: 180px;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.tc-row .form-input { flex: 1; min-width: 220px; }
.tc-desc { margin-left: 180px; }
.tc-actions { margin-top: 0.4rem; display: flex; justify-content: flex-end; }
.scan-toggle {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
}
.scan-toggle input { margin: 0; }

/* --- 094 Subsonic clone --- */
.clone-progress {
  margin-top: 0.8rem;
  border-top: 1px dashed var(--color-border-subtle);
  padding-top: 0.6rem;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.clone-stage-row {
  display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.clone-stage-label {
  color: var(--color-text-primary);
  letter-spacing: 0.05em;
  min-width: 110px;
}
.clone-stage-count {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}
.clone-stage-failed {
  color: var(--color-accent-primary);
}
.clone-log > summary {
  cursor: pointer;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
}
.clone-log-pre {
  margin: 0.4rem 0 0;
  padding: 0.6rem 0.8rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-secondary);
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Toast */
.tools-toast {
  position: fixed;
  bottom: 90px;
  right: 24px;
  z-index: 50;
  padding: 0.6rem 1rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-accent-primary);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.tools-toast.error { border-color: #e5484d; }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; }

.tools-work-pool-card, .tools-storage-card { padding: 1rem 1.2rem; margin-top: 0; }
.wp-refresh { background: none; border: 1px solid var(--color-border-subtle); border-radius: 4px; color: var(--color-text-secondary); cursor: pointer; font-size: var(--fs-sm); padding: 0.2rem 0.6rem; }
.wp-refresh:hover { border-color: var(--color-accent-dim); color: var(--color-text-primary); }
.wp-refresh:disabled { opacity: 0.5; cursor: default; }
/* countdown/running status sits left of the manual poll button */
.wp-header-actions { display: flex; align-items: center; gap: 0.6rem; }
.wp-auto-status { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); white-space: nowrap; }
.wp-auto-status-running { color: var(--color-accent-primary); }
.wp-progress-line { display: flex; justify-content: space-between; font-size: var(--fs-sm); margin-bottom: 0.3rem; }
.wp-progress-bar { height: 4px; background: var(--color-border); border-radius: 2px; overflow: hidden; margin-bottom: 0.8rem; }
.wp-progress-fill { height: 100%; background: var(--color-accent-primary); transition: width 0.3s; }
.wp-counts { display: flex; gap: 1.5rem; margin-bottom: 0.8rem; }
.wp-count { display: flex; flex-direction: column; align-items: center; }
.wp-count-label { font-size: var(--fs-xs); color: var(--color-text-muted); }
.wp-count-num { font-family: var(--font-mono); font-size: 1.1rem; font-weight: 600; color: var(--color-text-primary); }
.wp-count-emphasis .wp-count-num { color: #e5484d; }
.wp-workers { margin-bottom: 0.6rem; }
.wp-workers-title { font-size: var(--fs-xs); color: var(--color-text-muted); margin-bottom: 0.3rem; }
.wp-workers-empty { font-size: var(--fs-sm); color: var(--color-text-muted); }
.wp-workers-list { list-style: none; padding: 0; margin: 0; }
.wp-worker-row { display: flex; justify-content: space-between; padding: 0.2rem 0; font-size: var(--fs-sm); }
.wp-worker-name { color: var(--color-text-primary); }
.wp-worker-load { color: var(--color-text-muted); }
.wp-actions { display: flex; gap: 0.6rem; margin-bottom: 0.6rem; }
.wp-worker-toggle { padding-top: 0.5rem; border-top: 1px solid var(--color-border-subtle); }
.wp-toggle-label { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: var(--fs-sm); }
.wp-ineligible-hint { margin: 0.3rem 0 0; font-size: var(--fs-xs); color: var(--color-accent-primary); }
.wp-last-error { margin-top: 0.4rem; font-size: var(--fs-xs); color: #e5484d; }
.wp-current-song {
  display: flex; align-items: center; gap: 0.5rem;
  margin-bottom: 0.7rem; padding: 0.35rem 0.6rem;
  background: var(--color-bg-primary); border: 1px solid var(--color-border-subtle);
  border-radius: 4px; font-size: var(--fs-xs); color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wp-current-dot {
  flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-accent-primary); animation: wp-pulse 1.4s ease-in-out infinite;
}
@keyframes wp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.wp-speed-row { display: flex; gap: 1.5rem; margin-bottom: 0.8rem; padding-bottom: 0.8rem; border-bottom: 1px solid var(--color-border-subtle); }
.wp-speed-item { display: flex; flex-direction: column; align-items: center; gap: 0.15rem; }
.wp-local-stats { display: flex; align-items: center; gap: 0.6rem; padding-top: 0.6rem; font-size: var(--fs-sm); }
.wp-local-stat { font-family: var(--font-mono); font-size: var(--fs-xs); }
.wp-local-stat-ok { color: var(--color-text-secondary); }
.wp-local-stat-fail { color: #e5484d; }
.wp-caps { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; padding-top: 0.5rem; }
.wp-cap-pill {
  font-family: var(--font-mono); font-size: var(--fs-xs);
  padding: 0.1rem 0.5rem; border: 1px solid var(--color-border-subtle); border-radius: 999px;
  color: var(--color-text-secondary);
}
.wp-concurrency { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; padding-top: 0.6rem; }
.wp-concurrency-input { width: 5rem; }
.wp-concurrency-hint { font-size: var(--fs-xs); color: var(--color-text-muted); flex-basis: 100%; }
.storage-table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
.storage-table th, .storage-table td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid var(--color-border-subtle); font-size: var(--fs-sm); }
.storage-table .num-col { text-align: right; font-family: var(--font-mono); }

/* 孤儿歌曲清理 */
.orphan-hint { color: var(--color-text-muted); margin-bottom: 0.8rem; line-height: 1.5; }
.orphan-toolbar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.6rem; flex-wrap: wrap; }
.orphan-table td:first-child, .orphan-table th:first-child { width: 28px; }
.cost-rows { display: flex; flex-direction: column; gap: 0.4rem; }
.cost-row { display: flex; justify-content: space-between; font-size: var(--fs-sm); }
.cost-label { color: var(--color-text-muted); }
.cost-value { font-family: var(--font-mono); }
.cost-total-row { font-weight: 600; border-top: 1px solid var(--color-border-subtle); padding-top: 0.4rem; }
.cost-total { color: var(--color-accent-primary); }
.cost-row-input { flex-direction: column; gap: 0.3rem; }
.free-alloc-input-row { display: flex; align-items: center; gap: 0.4rem; }
.free-alloc-input { width: 60px; }
.storage-loading { padding: 1rem; color: var(--color-text-muted); font-size: var(--fs-sm); }
</style>
