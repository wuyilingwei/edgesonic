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
import { useAuth, parseXmlAttrs, formatSize } from "../api";
import { useWorkerPool } from "../stores/workerPool";
import TagEditor from "../components/TagEditor.vue";
import ScrapeButton from "../components/ScrapeButton.vue";
import type { ScrapeResult } from "../lib/scrape";
import { extractMetadata, isBrowserParse, suffixOf } from "../lib/metadata";

const { t } = useI18n();
const { authFetch, storageFetch, storagePost, tagFetch, edgesonicFetch, edgesonicPost, uploadFile, crossCopy, writeTags, submitMetadata, tidyFolder, restUrl, level, handleAuthError } = useAuth();
// 056 — Worker pool surface: progress / speed / pause / recent chips.
const workerPool = useWorkerPool();

interface StorageSource { id: string; type: string; name: string; baseUrl: string; }
interface DirEntry { name: string; }
interface FileEntry { name: string; size: number; contentType: string | null; uri: string; }

// Source selector state
const sources = ref<StorageSource[]>([]);
const currentSource = ref("r2");

// Browser state
const path = ref("music");
const dirs = ref<DirEntry[]>([]);
const files = ref<FileEntry[]>([]);
const loading = ref(false);

// Upload state — 089/S4: batch upload queue + per-file progress
const showUpload = ref(false);
const uploadInput = ref<HTMLInputElement | null>(null);
const uploadQueue = ref<File[]>([]);
const uploadProgressList = ref<number[]>([]); // 0-100 per file; -1 = failed
const uploadDoneCount = ref(0);
const uploadFailedNames = ref<string[]>([]);
const uploadBusy = ref(false);
const uploadMsg = ref("");
const uploadErr = ref(false);

// Cross-source copy state — 089/S4
const crossCopyModal = ref<{ file: FileEntry } | null>(null);
const crossCopyDestSource = ref("r2");
const crossCopyDestPath = ref("");
const crossCopyBusy = ref(false);

// Tag scan state
const scanning = ref(false);
const scanProcessed = ref(0);
const scanRemaining = ref<number | null>(null);

// Browser-side tag parse (041): for OGG/Opus/M4A/APE/... — the Worker tag
// parser only knows MP3/FLAC/WAV, so we let music-metadata (wasm-free, ~350KB
// gzip) handle the long tail right in the user's browser.
const browserScanning = ref(false);
const browserScanProcessed = ref(0);
const browserScanTagged = ref(0);
const browserScanTotal = ref(0);

// 051 — pending-instance queue surfaced by /storage/scan/pending. The badge in
// the page header shows the current backlog; the auto-drain loop pulls one
// batch at a time. The browser-auto behaviour is gated by the
// scan_browser_auto feature flag (read once at load).
interface PendingItem {
  instanceId: string;
  masterId: string;
  sourceId: string;
  storageUri: string;
  suffix: string;
  size: number;
}
const pendingCount = ref(0);
const pendingItems = ref<PendingItem[]>([]);
const scanBrowserAutoEnabled = ref(false);
const PENDING_BATCH = 50;
let autoTriggerHandle: number | null = null;

// R2 file operations state
const renamingFile = ref<string | null>(null); // file name currently being renamed
const renameInput = ref("");
const opModal = ref<{ file: FileEntry; mode: "move" | "copy" } | null>(null);
const opDestInput = ref("");
const opBusy = ref(false);

// Toast
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

const canUpload = computed(() => level.value >= 2);
const canScan = computed(() => level.value >= 2);
const isR2 = computed(() => currentSource.value === "r2");
const crumbs = computed(() => (path.value ? path.value.split("/") : []));
const uploadTarget = computed(() => (currentSource.value === "r2" ? "r2" : "webdav"));

function shortUrl(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

function sourceLabel(id: string): string {
  if (id === "r2") return "R2";
  const s = sources.value.find((x) => x.id === id);
  if (!s) return id;
  return s.name || `${s.type.toUpperCase()} · ${shortUrl(s.baseUrl)}`;
}

// R2 key from a FileEntry URI
function r2Key(f: FileEntry): string {
  return f.uri.startsWith("r2://") ? f.uri.slice(5) : f.uri;
}

async function loadSources() {
  try {
    const xml = await storageFetch("sources/list");
    sources.value = parseXmlAttrs(xml, "source")
      .filter((s) => s.enabled === "true" || s.enabled === "1")
      .map((s) => ({ id: s.id || "", type: s.type || "", name: s.name || "", baseUrl: s.baseUrl || "" }));
  } catch { sources.value = []; }
}

async function loadDir() {
  loading.value = true;
  renamingFile.value = null;
  try {
    const text = await storageFetch("files/list", { source: currentSource.value, path: path.value });
    const data = JSON.parse(text);
    if (data.ok !== true) throw new Error(data.error || "list failed");
    dirs.value = (data.dirs || []).slice().sort((a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name));
    files.value = (data.files || []).slice().sort((a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name));
  } catch {
    dirs.value = [];
    files.value = [];
    showToast(t("files.loadFailed"), "error");
  } finally {
    loading.value = false;
  }
}

function selectSource(id: string) {
  currentSource.value = id;
  path.value = id === "r2" ? "music" : "";
  loadDir();
  // 051 — refresh the pending badge whenever the storage source flips, so
  // the count tracks the active source.
  loadPending();
}

// 051 — pending list for the active source. Empty source ("r2" included) just
// resets the badge — only WebDAV sources can have incremental scans populate
// the queue. The endpoint validates the source server-side.
async function loadPending() {
  if (!currentSource.value || currentSource.value === "r2") {
    pendingCount.value = 0;
    pendingItems.value = [];
    return;
  }
  try {
    const text = await storageFetch("scan/pending", {
      source: currentSource.value,
      limit: String(PENDING_BATCH),
    });
    const data = JSON.parse(text);
    if (data?.ok) {
      pendingCount.value = data.total ?? 0;
      pendingItems.value = (data.items || []) as PendingItem[];
    } else {
      pendingCount.value = 0;
      pendingItems.value = [];
    }
  } catch {
    pendingCount.value = 0;
    pendingItems.value = [];
  }
}

// 051 — read scan_browser_auto from feature flags so the page knows whether to
// auto-drain. We deliberately don't gate by isSuperAdmin here; the user-level
// switch is the feature flag itself (admin-only writeable, but everyone
// honours the result).
async function loadScanFeatureFlags() {
  try {
    const text = await edgesonicFetch("features/list");
    const data = JSON.parse(text);
    if (data?.ok) {
      const strs = (data.featureStrings || []) as Array<{ key: string; value: string }>;
      const v = strs.find((s) => s.key === "scan_browser_auto")?.value;
      scanBrowserAutoEnabled.value = v !== "0";
    }
  } catch {
    // Non-admin users hit 403 on features/list; treat as auto-disabled which
    // mirrors the safer default for unsupervised cellular browsers.
    scanBrowserAutoEnabled.value = false;
  }
}

function enterDir(name: string) {
  path.value = path.value ? `${path.value}/${name}` : name;
  loadDir();
}

function goCrumb(index: number) {
  path.value = index < 0 ? "" : crumbs.value.slice(0, index + 1).join("/");
  loadDir();
}

// 089/S4 — collect all selected files into the queue (multiple allowed)
function onUploadFile(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files?.length) uploadQueue.value = Array.from(target.files);
}

// 089/S4 — serial upload loop: each file reports progress; single failure never
// aborts the rest; a summary toast is shown after the full queue drains.
async function doUpload() {
  if (!uploadQueue.value.length) { uploadMsg.value = t("files.selectFileFirst"); uploadErr.value = true; return; }
  uploadBusy.value = true;
  uploadErr.value = false;
  uploadDoneCount.value = 0;
  uploadFailedNames.value = [];
  uploadProgressList.value = uploadQueue.value.map(() => 0);
  const total = uploadQueue.value.length;
  try {
    for (let i = 0; i < total; i++) {
      const file = uploadQueue.value[i];
      uploadMsg.value = t("files.uploadingFile", { current: i + 1, total });
      try {
        await uploadFile(file, uploadTarget.value, path.value || undefined, {
          onProgress: (loaded, size) => {
            uploadProgressList.value[i] = size > 0 ? Math.round((loaded / size) * 100) : 0;
          },
        });
        uploadProgressList.value[i] = 100;
        uploadDoneCount.value++;
      } catch {
        uploadProgressList.value[i] = -1;
        uploadFailedNames.value.push(file.name);
      }
    }
    if (uploadFailedNames.value.length === 0) {
      showToast(t("files.uploadDone", { n: total }));
      uploadMsg.value = "";
    } else {
      uploadMsg.value = t("files.uploadPartialFail", { done: uploadDoneCount.value, failed: uploadFailedNames.value.length });
      uploadErr.value = true;
      showToast(uploadMsg.value, "error");
    }
    loadDir();
  } finally {
    uploadBusy.value = false;
    uploadQueue.value = [];
    uploadProgressList.value = [];
    if (uploadInput.value) uploadInput.value.value = "";
  }
}

// 089/S4 — Cross-source copy helpers
function openCrossModal(f: FileEntry) {
  crossCopyModal.value = { file: f };
  crossCopyDestSource.value = "r2";
  crossCopyDestPath.value = path.value;
}
function closeCrossModal() { crossCopyModal.value = null; }

async function confirmCrossOp() {
  if (!crossCopyModal.value) return;
  const { file } = crossCopyModal.value;
  crossCopyBusy.value = true;
  try {
    await crossCopy(file.uri, crossCopyDestSource.value, crossCopyDestPath.value);
    showToast(t("files.crossCopied"));
    closeCrossModal();
  } catch (e) {
    showToast(e instanceof Error ? e.message : t("files.crossCopyFailed"), "error");
  } finally {
    crossCopyBusy.value = false;
  }
}

async function runTagScan() {
  if (scanning.value) return;
  scanning.value = true;
  scanProcessed.value = 0;
  scanRemaining.value = null;
  let totalTagged = 0;
  try {
    for (;;) {
      const text = await tagFetch("read", { batch: "4" });
      const data = JSON.parse(text);
      if (data.ok !== true) { showToast(t("files.scanFailed"), "error"); return; }
      scanProcessed.value += data.processed || 0;
      totalTagged += data.tagged || 0;
      scanRemaining.value = data.remaining ?? 0;
      if (!data.remaining) break;
    }
    showToast(t("files.scanDone", { tagged: totalTagged }));
  } catch {
    showToast(t("files.scanFailed"), "error");
  } finally {
    scanning.value = false;
    scanRemaining.value = null;
  }
}

// 041 + 051 — browser-side metadata parse pump.
//
// Two modes:
//   • pending-list mode (preferred, /storage/scan/pending) — drives the
//     incremental scanner backlog: instances whose tag_scanned=0 (either
//     because the WebDAV scanner just imported them or because their ETag /
//     lastModified / size changed). Iterates batches of PENDING_BATCH until
//     the queue empties or the user navigates away.
//   • directory fallback — when the active source has no pending items
//     (or we're on R2), parse every browser-parseable file in the current
//     directory listing. Original 041 behaviour, preserved so a fresh
//     upload still gets tags before the next scan tick.
async function runBrowserRead() {
  if (browserScanning.value) return;
  // Prefer the pending list if it exists for the current source.
  if (pendingItems.value.length > 0) {
    await drainPendingQueue();
    return;
  }
  // Fallback: scan the directory listing.
  const targets = files.value.filter((f) => isBrowserParse(suffixOf(f.name)));
  if (!targets.length) {
    showToast(t("files.browserReadNothing"), "success");
    return;
  }
  browserScanning.value = true;
  browserScanProcessed.value = 0;
  browserScanTagged.value = 0;
  browserScanTotal.value = targets.length;
  try {
    for (const f of targets) {
      browserScanProcessed.value++;
      try {
        const lookup = JSON.parse(await tagFetch("findInstanceByUri", { uri: f.uri }));
        if (!lookup?.ok || !lookup.instanceId || !lookup.masterId) continue;
        const resp = await fetch(restUrl("stream", { id: lookup.masterId }));
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const file = new File([blob], f.name, { type: f.contentType || blob.type });
        const meta = await extractMetadata(file);
        const submit = await submitMetadata(lookup.instanceId, meta as Record<string, string | number>);
        if (submit.ok) browserScanTagged.value++;
      } catch { /* per-file failures don't poison the batch */ }
    }
    showToast(t("files.browserReadDone", { tagged: browserScanTagged.value, total: targets.length }));
  } finally {
    browserScanning.value = false;
  }
}

// 051 — Pull pending batches in a loop until the backlog is empty or every
// item in the batch failed (defensive: avoids an infinite spin on bad data).
async function drainPendingQueue() {
  browserScanning.value = true;
  browserScanProcessed.value = 0;
  browserScanTagged.value = 0;
  browserScanTotal.value = pendingCount.value;
  try {
    let safetyBudget = 20;                               // ≤ 20 × 50 = 1000 items per click
    while (pendingItems.value.length > 0 && safetyBudget > 0) {
      safetyBudget--;
      const batch = pendingItems.value.slice();
      let batchTagged = 0;
      for (const item of batch) {
        // suffix gate so we don't waste a /rest/stream call on the formats
        // the Worker tag parser already handles.
        if (!isBrowserParse(item.suffix)) {
          browserScanProcessed.value++;
          continue;
        }
        browserScanProcessed.value++;
        try {
          const resp = await fetch(restUrl("stream", { id: item.masterId }));
          if (!resp.ok) continue;
          const blob = await resp.blob();
          const file = new File([blob], item.storageUri, { type: blob.type });
          const meta = await extractMetadata(file);
          const submit = await submitMetadata(item.instanceId, meta as Record<string, string | number>);
          if (submit.ok) {
            browserScanTagged.value++;
            batchTagged++;
          }
        } catch { /* per-file failures don't poison the batch */ }
      }
      // Refresh — if nothing in this batch managed to flip tag_scanned, the
      // server can't make progress so stop (would otherwise spin forever).
      await loadPending();
      if (batchTagged === 0) break;
    }
    showToast(
      t("files.browserReadDone", { tagged: browserScanTagged.value, total: browserScanTotal.value }),
    );
  } finally {
    browserScanning.value = false;
  }
}

// 051 — auto-drain trigger. Page must be visible, the flag must be on, and
// a non-zero pending count must exist. We delay by 5s after the user lands on
// the page so a quick tab-flip doesn't spin up the loop unnecessarily.
function scheduleAutoDrain() {
  if (autoTriggerHandle !== null) {
    clearTimeout(autoTriggerHandle);
    autoTriggerHandle = null;
  }
  if (!scanBrowserAutoEnabled.value) return;
  if (document.visibilityState !== "visible") return;
  if (browserScanning.value) return;
  if (pendingCount.value <= 0) return;
  autoTriggerHandle = window.setTimeout(() => {
    autoTriggerHandle = null;
    if (
      scanBrowserAutoEnabled.value &&
      document.visibilityState === "visible" &&
      !browserScanning.value &&
      pendingItems.value.length > 0
    ) {
      drainPendingQueue();
    }
  }, 5000);
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") scheduleAutoDrain();
  else if (autoTriggerHandle !== null) {
    clearTimeout(autoTriggerHandle);
    autoTriggerHandle = null;
  }
}

// ── R2 file operations ──────────────────────────────────────────────────────

function startRename(f: FileEntry) {
  renamingFile.value = f.name;
  renameInput.value = f.name;
}

function cancelRename() {
  renamingFile.value = null;
  renameInput.value = "";
}

async function confirmRename(f: FileEntry) {
  const newName = renameInput.value.trim();
  if (!newName || newName === f.name) { cancelRename(); return; }
  const fromKey = r2Key(f);
  const dir = path.value ? path.value + "/" : "";
  const toKey = dir + newName;
  opBusy.value = true;
  try {
    const res = await storagePost("files/move", { key: fromKey, dest: toKey });
    if (!JSON.parse(res).ok) throw new Error();
    showToast(t("files.renamed"));
    loadDir();
  } catch { showToast(t("files.opFailed"), "error"); }
  finally { opBusy.value = false; cancelRename(); }
}

function openMoveModal(f: FileEntry, mode: "move" | "copy") {
  opModal.value = { file: f, mode };
  opDestInput.value = path.value;
}

function closeOpModal() { opModal.value = null; opDestInput.value = ""; }

async function confirmOp() {
  if (!opModal.value) return;
  const { file, mode } = opModal.value;
  const destDir = opDestInput.value.replace(/\/$/, "");
  const fromKey = r2Key(file);
  const toKey = (destDir ? destDir + "/" : "") + file.name;
  opBusy.value = true;
  try {
    const endpoint = mode === "move" ? "files/move" : "files/copy";
    const res = await storagePost(endpoint, { key: fromKey, dest: toKey });
    if (!JSON.parse(res).ok) throw new Error();
    showToast(mode === "move" ? t("files.moved") : t("files.copied"));
    closeOpModal();
    loadDir();
  } catch { showToast(t("files.opFailed"), "error"); }
  finally { opBusy.value = false; }
}

async function deleteFile(f: FileEntry) {
  if (!confirm(t("files.deleteConfirm", { name: f.name }))) return;
  const key = r2Key(f);
  opBusy.value = true;
  try {
    const res = await storagePost("files/delete", { key });
    if (!JSON.parse(res).ok) throw new Error();
    showToast(t("files.deleted"));
    loadDir();
  } catch { showToast(t("files.opFailed"), "error"); }
  finally { opBusy.value = false; }
}

// ── Tag editor (single mode only — batch lives in Library) ─────────────────
const editorOpen = ref(false);
const editTargetId = ref<string | null>(null);
const editInitial = ref<Record<string, string | number>>({});
const editBusy = ref(false);
const editMsg = ref("");
const editErr = ref(false);

const canEditTags = computed(() => level.value >= 2);
const isAudio = (name: string) => /\.(mp3|flac|wav|ogg|opus|m4a|aac)$/i.test(name);

async function openTagEditor(f: FileEntry) {
  // Worker writeTags wants a song master_id; resolve it via search3 on the
  // filename stem. If unique → open editor; if 0 hits → toast asks user to scan.
  const stem = f.name.replace(/\.[^.]+$/, "");
  try {
    const xml = await authFetch("search3", { query: stem, songCount: "20", artistCount: "0", albumCount: "0" });
    const songs = parseXmlAttrs(xml, "song");
    if (!songs.length) {
      showToast(t("files.editLookupFailed"), "error");
      return;
    }
    // Best-effort match: prefer the entry whose title equals the stem.
    const hit = songs.find((s) => (s.title || "").toLowerCase() === stem.toLowerCase()) || songs[0];
    if (songs.length > 1) showToast(t("files.editLookupAmbiguous", { n: songs.length }), "success");
    editTargetId.value = hit.id || null;
    editInitial.value = {
      title: hit.title || "",
      artist: hit.artist || "",
      album: hit.album || "",
      albumArtist: hit.albumArtist || "",
      genre: hit.genre || "",
      year: hit.year || "",
      track: hit.track || "",
      disc: hit.discNumber || "",
    };
    editMsg.value = ""; editErr.value = false;
    editorOpen.value = true;
  } catch {
    showToast(t("files.editLookupFailed"), "error");
  }
}

function closeTagEditor() { editorOpen.value = false; }

// === 040 scrape-button helpers (single mode only — Files.vue has no batch) ===
function scrapeQueryFromForm(form: Record<string, string>): string {
  const t1 = (form.title || "").trim();
  const a1 = (form.artist || "").trim();
  if (t1 || a1) return [t1, a1].filter(Boolean).join(" ");
  const init = editInitial.value;
  return [init.title, init.artist].filter(Boolean).join(" ");
}

function applyScrapeResult(
  form: Record<string, string>,
  applyFlags: Record<string, boolean>,
  r: ScrapeResult,
) {
  if (r.title) form.title = r.title;
  if (r.artist) form.artist = r.artist;
  if (r.album) form.album = r.album;
  if (r.year) form.year = String(r.year);
  if (r.title) applyFlags.title = true;
  if (r.artist) applyFlags.artist = true;
  if (r.album) applyFlags.album = true;
  if (r.year) applyFlags.year = true;
}

// ── Tidy folder (042) — template-driven move on R2 / WebDAV ─────────────────
// Two-step UX: open the modal → run a dry-run → review plan → "Apply" runs it
// for real. Avoids accidental large-scale moves on a typo'd template.
const DEFAULT_TIDY_TEMPLATE = "{albumArtist}/{album}/{track:02d} - {title}";
const tidyOpen = ref(false);
const tidyTemplate = ref(DEFAULT_TIDY_TEMPLATE);
const tidyDryRun = ref(true);
const tidyBusy = ref(false);
const tidyMsg = ref("");
const tidyErr = ref(false);
const tidyPlanned = ref<Array<{ id: string; instanceId: string; from: string; to: string; skipped?: string }>>([]);
const tidyApplied = ref<Array<{ id: string; instanceId: string; ok: boolean; error?: string }>>([]);
const tidyTargetIds = ref<string[]>([]);

const canTidy = computed(() => level.value >= 2);

async function openTidyFolder() {
  // Resolve master_ids for every audio file in the current dir, the same way
  // we resolve them for the single-track tag editor (search3 on the filename
  // stem). Anything that doesn't resolve is silently dropped — the user has
  // already been told to run a scan first via the editor's affordance.
  const ids: string[] = [];
  for (const f of files.value) {
    if (!isAudio(f.name)) continue;
    const stem = f.name.replace(/\.[^.]+$/, "");
    try {
      const xml = await authFetch("search3", { query: stem, songCount: "5", artistCount: "0", albumCount: "0" });
      const songs = parseXmlAttrs(xml, "song");
      const hit = songs.find((s) => (s.title || "").toLowerCase() === stem.toLowerCase()) || songs[0];
      if (hit?.id) ids.push(hit.id);
    } catch {
      // skip — partial coverage is still useful
    }
  }
  if (!ids.length) {
    showToast(t("files.tidyEmpty"), "error");
    return;
  }
  tidyTargetIds.value = ids;
  tidyTemplate.value = DEFAULT_TIDY_TEMPLATE;
  tidyDryRun.value = true;
  tidyPlanned.value = [];
  tidyApplied.value = [];
  tidyMsg.value = "";
  tidyErr.value = false;
  tidyOpen.value = true;
}

async function runTidyFolder() {
  if (!tidyTargetIds.value.length || !tidyTemplate.value.trim()) return;
  tidyBusy.value = true; tidyMsg.value = ""; tidyErr.value = false;
  try {
    const res = await tidyFolder(tidyTargetIds.value, tidyTemplate.value, {
      dryRun: tidyDryRun.value,
      source: currentSource.value === "r2" ? "r2" : undefined,
    });
    if (!res.ok) {
      tidyErr.value = true;
      tidyMsg.value = res.error || t("files.tidyFailed");
      return;
    }
    tidyPlanned.value = res.planned || [];
    tidyApplied.value = res.applied || [];
    if (!tidyDryRun.value) {
      const ok = (res.applied || []).filter((a) => a.ok).length;
      tidyMsg.value = t("files.tidyDone", { ok, failed: res.failed ?? 0 });
      loadDir();
    }
  } catch {
    tidyErr.value = true;
    tidyMsg.value = t("files.tidyFailed");
  } finally {
    tidyBusy.value = false;
  }
}

function closeTidyFolder() { tidyOpen.value = false; }

// ── 056 — work-queue HUD ───────────────────────────────────────────────────
// HUD pulls /edgesonic/work/status every 30s so super-admins can watch the
// queue counts + cancel stuck failures. Non-admins hit 403 → we just hide
// the failed-list panel and rely on store-side stats for progress.
interface WorkStatusRecent {
  id: string;
  task_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error_message: string | null;
  created_at: number;
}
interface WorkStatusResp {
  ok: boolean;
  counts?: Record<string, number>;
  recent?: WorkStatusRecent[];
  error?: string;
}
const workStatus = ref<WorkStatusResp | null>(null);
const workStatusError = ref<string | null>(null);
const cancelingId = ref<string | null>(null);
const isSuperAdmin = computed(() => level.value >= 3);
const showWorkQueueHud = computed(() =>
  workerPool.isWorking ||
  workerPool.stats.completed > 0 ||
  workerPool.stats.failed > 0 ||
  (workStatus.value?.counts?.queued ?? 0) > 0,
);
const queuedTotal = computed(() => workStatus.value?.counts?.queued ?? 0);
const failedRows = computed(
  () => (workStatus.value?.recent || []).filter((r) => r.status === "failed").slice(0, 10),
);
const failedCount = computed(() => workStatus.value?.counts?.failed ?? 0);
const progressPct = computed(() => {
  const done = workerPool.stats.completed;
  const total = done + queuedTotal.value;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
});

async function loadWorkStatus() {
  if (!isSuperAdmin.value) return;
  try {
    const text = await edgesonicFetch("work/status");
    const data: WorkStatusResp = JSON.parse(text);
    if (data.ok) {
      workStatus.value = data;
      workStatusError.value = null;
    } else {
      workStatusError.value = data.error || t("files.workQueue.statusLoadFailed");
    }
  } catch (e) {
    if (handleAuthError(e)) {
      showToast(t("common.sessionExpired"), "error");
      stopWorkStatusPolling();
      return;
    }
    workStatusError.value = t("files.workQueue.statusLoadFailed");
  }
}

async function cancelWorkTask(id: string) {
  cancelingId.value = id;
  try {
    const text = await edgesonicPost("work/cancel", { id });
    const data = JSON.parse(text);
    if (data?.ok) {
      showToast(t("files.workQueue.canceled"));
      await loadWorkStatus();
    } else {
      showToast(t("files.workQueue.cancelFailed"), "error");
    }
  } catch {
    showToast(t("files.workQueue.cancelFailed"), "error");
  } finally {
    cancelingId.value = null;
  }
}

function toggleWorkerPool() {
  const next = !workerPool.enabled;
  workerPool.setEnabled(next);
  if (next) {
    // Force an immediate poll so the user gets feedback the resume happened.
    void workerPool.pollNow();
  }
}

let workStatusHandle: number | null = null;
function startWorkStatusPolling() {
  if (workStatusHandle !== null) return;
  if (!isSuperAdmin.value) return;
  // Kick off an initial fetch so the panel populates without waiting 30s.
  void loadWorkStatus();
  workStatusHandle = window.setInterval(loadWorkStatus, 30_000);
}
function stopWorkStatusPolling() {
  if (workStatusHandle !== null) {
    clearInterval(workStatusHandle);
    workStatusHandle = null;
  }
}
function onWorkStatusVisibilityChange() {
  if (document.visibilityState === "visible") startWorkStatusPolling();
  else stopWorkStatusPolling();
}

async function onTagEditorSubmit(patch: Record<string, string | number>, cover?: { data: string; mime: string }) {
  if (!editTargetId.value || (!Object.keys(patch).length && !cover)) return;
  editBusy.value = true; editMsg.value = ""; editErr.value = false;
  try {
    const res = await writeTags(editTargetId.value, patch, cover);
    if (!res.ok) {
      editErr.value = true;
      editMsg.value = res.error || t("library.editFailed");
    } else {
      const files = res.files || [];
      const written = files.filter((x) => x.written).length;
      editMsg.value = t("library.editSaved", { written, total: files.length });
      // brief delay so the user reads it, then close
      setTimeout(() => { editorOpen.value = false; }, 1200);
    }
  } catch {
    editErr.value = true;
    editMsg.value = t("library.editFailed");
  }
  editBusy.value = false;
}

onMounted(async () => {
  await loadSources();
  await loadScanFeatureFlags();
  await loadDir();
  await loadPending();
  document.addEventListener("visibilitychange", onVisibilityChange);
  scheduleAutoDrain();
  // 056 — start the work/status poller (no-op for non-super-admin).
  document.addEventListener("visibilitychange", onWorkStatusVisibilityChange);
  startWorkStatusPolling();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (autoTriggerHandle !== null) {
    clearTimeout(autoTriggerHandle);
    autoTriggerHandle = null;
  }
  document.removeEventListener("visibilitychange", onWorkStatusVisibilityChange);
  stopWorkStatusPolling();
});

// 051 — when the pending count drops to zero (or jumps after a manual scan)
// re-evaluate whether auto-drain should kick in.
watch(pendingCount, () => scheduleAutoDrain());
</script>

<template>
  <div class="files-page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("files.label") }}</div>
        <h1 class="page-title">{{ t("files.title") }}</h1>
      </div>
      <div class="page-actions">
        <span v-if="scanning" class="scan-progress">{{ t("files.scanProgress", { processed: scanProcessed, remaining: scanRemaining ?? "…" }) }}</span>
        <span v-if="browserScanning" class="scan-progress">{{ t("files.browserReadProgress", { processed: browserScanProcessed, total: browserScanTotal }) }}</span>
        <span v-if="!browserScanning && pendingCount > 0" class="pending-badge" :title="t('files.pendingBadgeTitle')">
          {{ t("files.pendingBadge", { n: pendingCount }) }}
        </span>
        <button v-if="canScan" class="btn-secondary" :disabled="scanning || browserScanning" @click="runTagScan">{{ t("files.scanTags") }}</button>
        <button v-if="canScan" class="btn-secondary" :disabled="scanning || browserScanning" @click="runBrowserRead">{{ t("files.browserRead") }}</button>
        <button v-if="canTidy" class="btn-secondary" :disabled="scanning || browserScanning || tidyBusy" @click="openTidyFolder">{{ t("files.tidy") }}</button>
        <button v-if="canUpload" class="btn-primary" @click="showUpload = !showUpload">{{ t("files.upload") }}</button>
      </div>
    </div>

    <!-- 056 — Work-queue HUD: progress + speed + pause + recent chips.
         Failed list panel only shows for super-admin (the /work/status
         endpoint is level=3, non-admins simply don't get the data). -->
    <div v-if="showWorkQueueHud" class="work-queue-card card">
      <div class="card-header">
        <span class="card-title">{{ t("files.workQueue.title") }}</span>
        <div class="wq-actions">
          <button
            v-if="workerPool.eligible"
            class="btn-secondary wq-toggle"
            :class="{ resumed: workerPool.enabled }"
            @click="toggleWorkerPool"
          >
            {{ workerPool.enabled ? t("files.workQueue.pause") : t("files.workQueue.resume") }}
          </button>
        </div>
      </div>

      <div class="wq-progress-line">
        <span v-if="queuedTotal > 0" class="wq-progress-text">
          {{ t("files.workQueue.progress", { completed: workerPool.stats.completed, queued: queuedTotal }) }}
        </span>
        <span v-else class="wq-progress-text">
          {{ t("files.workQueue.progressNoQueue", { completed: workerPool.stats.completed, failed: workerPool.stats.failed }) }}
        </span>
        <span class="wq-speed">
          <template v-if="workerPool.speedPerMin === null">{{ t("files.workQueue.speedPending") }}</template>
          <template v-else>{{ t("files.workQueue.speed", { speed: workerPool.speedPerMin }) }}</template>
        </span>
      </div>

      <div v-if="queuedTotal > 0" class="wq-progress-bar">
        <div class="wq-progress-fill" :style="{ width: progressPct + '%' }"></div>
      </div>

      <div v-if="workerPool.stats.currentTaskType" class="wq-current mono-label">
        {{ t("files.workQueue.current", { type: workerPool.stats.currentTaskType }) }}
      </div>

      <p v-if="!workerPool.enabled" class="wq-paused-hint">{{ t("files.workQueue.paused") }}</p>

      <!-- Recent task chips — only when we have something to show. -->
      <div v-if="workerPool.recent.length" class="wq-recent">
        <div class="mono-label wq-recent-label">{{ t("files.workQueue.recent") }}</div>
        <div class="wq-recent-list">
          <div
            v-for="r in workerPool.recent"
            :key="r.id"
            class="wq-recent-chip"
            :class="{ 'wq-ok': r.status === 'ok', 'wq-fail': r.status === 'fail' }"
            :title="r.error || r.taskType"
          >
            <span class="wq-chip-icon">{{ r.status === "ok" ? "✓" : "✗" }}</span>
            <span class="wq-chip-name">{{ r.fileName }}</span>
          </div>
        </div>
      </div>

      <!-- Super-admin failed-task panel — pulls /work/status every 30s. -->
      <div v-if="isSuperAdmin && failedCount > 0" class="wq-failed">
        <div class="wq-failed-header">
          <span class="mono-label">{{ t("files.workQueue.failed", { n: failedCount }) }}</span>
          <button class="btn-secondary wq-refresh" @click="loadWorkStatus">{{ t("files.workQueue.refresh") }}</button>
        </div>
        <div v-if="failedRows.length" class="wq-failed-list">
          <div v-for="row in failedRows" :key="row.id" class="wq-failed-row">
            <span class="wq-failed-text" :title="row.error_message || ''">
              {{ t("files.workQueue.failedRow", { type: row.task_type, error: (row.error_message || "").slice(0, 80) }) }}
            </span>
            <button
              class="op-btn wq-cancel"
              :disabled="cancelingId === row.id"
              @click="cancelWorkTask(row.id)"
            >{{ t("files.workQueue.cancel") }}</button>
          </div>
        </div>
        <div v-else class="wq-failed-empty">{{ t("files.workQueue.failedEmpty") }}</div>
      </div>

      <p v-if="workStatusError" class="wq-error">{{ workStatusError }}</p>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <div class="source-bar">
      <span class="source-bar-label">{{ t("files.source") }}</span>
      <button :class="['source-tab', { active: currentSource === 'r2' }]" @click="selectSource('r2')">R2</button>
      <button
        v-for="s in sources" :key="s.id"
        :class="['source-tab', { active: currentSource === s.id }]"
        @click="selectSource(s.id)"
      >{{ s.name || `${s.type.toUpperCase()} · ${shortUrl(s.baseUrl)}` }}</button>
    </div>

    <div v-if="showUpload && canUpload" class="card upload-panel">
      <div class="card-header"><span class="card-title">{{ t("files.uploadFile") }}</span></div>
      <div class="form-row">
        <div class="form-group" style="flex:1">
          <label class="form-label">{{ t("files.target") }}</label>
          <div class="upload-dest">{{ sourceLabel(currentSource) }} : /{{ path }}</div>
        </div>
        <div class="form-group" style="flex:2">
          <label class="form-label">{{ t("files.file") }}</label>
          <input ref="uploadInput" type="file" multiple accept="audio/*" class="form-input" @change="onUploadFile" />
        </div>
        <button class="btn-primary" :disabled="!uploadQueue.length || uploadBusy" @click="doUpload">{{ t("files.uploadBtn") }}</button>
      </div>
      <!-- 089/S4: Upload queue list with per-file progress bars -->
      <div v-if="uploadQueue.length || uploadBusy" class="upload-queue">
        <div class="mono-label upload-queue-header">{{ t("files.uploadQueue") }}</div>
        <div v-for="(file, i) in uploadQueue" :key="i" class="upload-queue-item">
          <span class="upload-queue-name">{{ file.name }}</span>
          <div class="upload-queue-bar">
            <div
              class="upload-queue-fill"
              :class="{ 'fill-error': uploadProgressList[i] === -1 }"
              :style="{ width: Math.max(0, uploadProgressList[i] ?? 0) + '%' }"
            ></div>
          </div>
          <span class="upload-queue-pct">{{ uploadProgressList[i] === -1 ? '✕' : (uploadProgressList[i] ?? 0) + '%' }}</span>
        </div>
        <div v-if="uploadBusy" class="upload-queue-overall">{{ uploadMsg }}</div>
      </div>
      <p v-if="uploadMsg && !uploadBusy" :class="['upload-msg', { error: uploadErr }]">{{ uploadMsg }}</p>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <div class="card browser-card">
      <div class="breadcrumb">
        <button class="crumb" :disabled="!path" @click="goCrumb(-1)">{{ t("files.root") }}</button>
        <template v-for="(seg, i) in crumbs" :key="i">
          <span class="crumb-sep">/</span>
          <button class="crumb" :disabled="i === crumbs.length - 1" @click="goCrumb(i)">{{ seg }}</button>
        </template>
        <span class="browser-stats">{{ t("files.stats", { dirs: dirs.length, files: files.length }) }}</span>
      </div>

      <div class="entry-list">
        <div v-if="loading" class="list-loading">{{ t("common.loading") }}</div>
        <template v-else>
          <div v-for="d in dirs" :key="`d-${d.name}`" class="entry-row dir-row" @click="enterDir(d.name)">
            <span class="entry-icon">📁</span>
            <span class="entry-name">{{ d.name }}</span>
          </div>
          <div v-for="f in files" :key="`f-${f.name}`" class="entry-row file-row" :class="{ 'row-renaming': renamingFile === f.name }">
            <span class="entry-icon file-icon">▪</span>
            <!-- Rename: inline input -->
            <template v-if="renamingFile === f.name">
              <input
                v-model="renameInput"
                class="rename-input"
                @keydown.enter="confirmRename(f)"
                @keydown.escape="cancelRename"
                autofocus
              />
              <button class="op-btn op-confirm" :disabled="opBusy" @click="confirmRename(f)">✓</button>
              <button class="op-btn op-cancel" @click="cancelRename">✕</button>
            </template>
            <template v-else>
              <span class="entry-name">{{ f.name }}</span>
              <span class="entry-size">{{ formatSize(f.size) }}</span>
              <!-- Tag edit (audio + edit perm) — works on R2 & WebDAV; resolves master_id via search3 -->
              <button
                v-if="canEditTags && isAudio(f.name)"
                class="op-btn op-edit-tag"
                :title="t('files.editTags')"
                @click.stop="openTagEditor(f)"
              >♪</button>
              <!-- Cross-source copy (all sources, canUpload) — 089/S4b -->
              <button
                v-if="canUpload"
                class="op-btn op-cross"
                :title="t('files.crossCopyTo')"
                @click.stop="openCrossModal(f)"
              >⧉</button>
              <!-- R2-only operations -->
              <template v-if="isR2 && canUpload">
                <button class="op-btn op-rename" :title="t('files.rename')" @click.stop="startRename(f)">✎</button>
                <button class="op-btn op-move" :title="t('files.moveTo')" @click.stop="openMoveModal(f, 'move')">→</button>
                <button class="op-btn op-copy" :title="t('files.copyTo')" @click.stop="openMoveModal(f, 'copy')">⊕</button>
                <button class="op-btn op-delete" :title="t('files.deleteFile')" :disabled="opBusy" @click.stop="deleteFile(f)">✕</button>
              </template>
            </template>
          </div>
          <div v-if="!dirs.length && !files.length" class="empty-state">{{ t("files.empty") }}</div>
        </template>
      </div>
      <div class="corner corner-tr"></div>
      <div class="corner corner-bl"></div>
    </div>

    <!-- Move / Copy modal -->
    <div v-if="opModal" class="modal-backdrop" @click.self="closeOpModal">
      <div class="modal">
        <div class="modal-title">{{ opModal.mode === "move" ? t("files.moveTo") : t("files.copyTo") }}: {{ opModal.file.name }}</div>
        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.destPath") }}</label>
          <input v-model="opDestInput" class="form-input" placeholder="music/subfolder" @keydown.enter="confirmOp" @keydown.escape="closeOpModal" />
          <span class="field-hint">{{ t("files.destPathHint") }}</span>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeOpModal">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="opBusy" @click="confirmOp">{{ opModal.mode === "move" ? t("files.move") : t("files.copy") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- Cross-source copy modal — 089/S4b -->
    <div v-if="crossCopyModal" class="modal-backdrop" @click.self="closeCrossModal">
      <div class="modal">
        <div class="modal-title">{{ t("files.crossCopyTitle") }}: {{ crossCopyModal.file.name }}</div>
        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.source") }}</label>
          <select v-model="crossCopyDestSource" class="form-input">
            <option value="r2">{{ t("files.localR2") }}</option>
            <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name || s.id }}</option>
          </select>
        </div>
        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.crossCopyPath") }}</label>
          <input v-model="crossCopyDestPath" class="form-input" :placeholder="path" @keydown.enter="confirmCrossOp" @keydown.escape="closeCrossModal" />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeCrossModal">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="crossCopyBusy" @click="confirmCrossOp">{{ t("files.crossCopyBtn") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <!-- Tag editor (single mode — batch lives in Library) -->
    <TagEditor
      :open="editorOpen"
      mode="single"
      :song-ids="editTargetId ? [editTargetId] : []"
      :initial-tags="editInitial"
      :busy="editBusy"
      :message="editMsg"
      :error="editErr"
      @submit="onTagEditorSubmit"
      @close="closeTagEditor"
    >
      <!-- 040 scrape button in extras slot -->
      <template #extras="{ form, apply }">
        <ScrapeButton
          :initial-query="scrapeQueryFromForm(form)"
          :song-master-id="editTargetId || ''"
          @apply="(r: ScrapeResult) => applyScrapeResult(form, apply, r)"
        />
      </template>
    </TagEditor>

    <!-- Tidy folder modal (042) -->
    <div v-if="tidyOpen" class="modal-backdrop" @click.self="closeTidyFolder">
      <div class="modal tidy-modal">
        <div class="modal-title">{{ t("files.tidyTitle", { n: tidyTargetIds.length }) }}</div>

        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label">{{ t("files.tidyTemplate") }}</label>
          <input v-model="tidyTemplate" class="form-input" :placeholder="DEFAULT_TIDY_TEMPLATE" />
          <span class="field-hint">{{ t("files.tidyTemplateHint", { ph: "{albumArtist} {album} {artist} {title} {year} {track} {track:02d}", ex: DEFAULT_TIDY_TEMPLATE }) }}</span>
        </div>

        <label class="dry-run-row">
          <input type="checkbox" v-model="tidyDryRun" />
          <span>{{ t("files.tidyDryRun") }}</span>
        </label>

        <div v-if="tidyPlanned.length" class="tidy-plan">
          <div class="tidy-plan-title mono-label">
            {{ tidyDryRun ? t("files.tidyPlanned") : t("files.tidyApplied") }} ({{ tidyPlanned.length }})
          </div>
          <div class="tidy-plan-list">
            <div v-for="(p, i) in tidyPlanned" :key="p.instanceId + i" class="tidy-row">
              <div class="tidy-from mono-label">{{ p.from }}</div>
              <div class="tidy-arrow">→</div>
              <div class="tidy-to mono-label">
                <template v-if="p.skipped">{{ t("files.tidySkipped", { reason: p.skipped }) }}</template>
                <template v-else>{{ p.to }}</template>
              </div>
            </div>
          </div>
        </div>

        <p v-if="tidyMsg" :class="['te-msg', { error: tidyErr }]">{{ tidyMsg }}</p>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeTidyFolder">{{ t("common.cancel") }}</button>
          <button class="btn-primary" :disabled="tidyBusy || !tidyTemplate.trim()" @click="runTidyFolder">
            {{ tidyBusy ? t("common.loading") : t("files.tidyRun") }}
          </button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.files-page { max-width: 1100px; }
.page-actions { display: flex; gap: 0.5rem; align-items: center; }
.scan-progress {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-accent-primary);
  letter-spacing: 0.05em;
  animation: pulse 2s ease-in-out infinite;
}
/* 051 — pending count badge in the header actions row */
.pending-badge {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--color-border-default);
  border-radius: 2px;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
}

.source-bar {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  margin-bottom: 1.25rem;
}
.source-bar-label {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-right: 0.25rem;
}
.source-tab {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  padding: 0.4rem 0.9rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.1s;
}
.source-tab:hover { background: var(--color-bg-tertiary); color: var(--color-text-primary); }
.source-tab.active {
  background: var(--color-accent-dim);
  border-color: var(--color-accent-primary);
  color: var(--color-accent-primary);
}

.upload-panel { margin-bottom: 1.25rem; }
.upload-dest {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-accent-primary);
  padding: 0.45rem 0;
  word-break: break-all;
}
.upload-msg { font-family: var(--font-mono); font-size: var(--fs-sm); margin-top: 0.5rem; color: var(--color-status-success); }
.upload-msg.error { color: var(--color-status-error); }

.browser-card { padding: 0; overflow: hidden; }
.breadcrumb {
  display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap;
  padding: 0.75rem 1rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
}
.crumb {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  background: none; border: none; padding: 0;
  color: var(--color-accent-primary);
  cursor: pointer;
}
.crumb:hover { text-decoration: underline; }
.crumb:disabled { color: var(--color-text-primary); cursor: default; text-decoration: none; }
.crumb-sep { color: var(--color-text-muted); }
.browser-stats {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.08em;
}

.entry-list { max-height: 65vh; overflow-y: auto; }
.list-loading {
  padding: 1.5rem; text-align: center;
  font-family: var(--font-mono); font-size: var(--fs-sm);
  color: var(--color-text-muted);
  animation: pulse 2s ease-in-out infinite;
}
.entry-row {
  display: flex; align-items: center; gap: 0.7rem;
  padding: 0.45rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
  border-left: 2px solid transparent;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.entry-row:last-child { border-bottom: none; }
.dir-row { cursor: pointer; transition: all 0.1s; }
.dir-row:hover {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-accent-primary);
  color: var(--color-accent-primary);
}
.row-renaming { background: var(--color-bg-tertiary); border-left-color: var(--color-accent-primary); }
.entry-icon { flex-shrink: 0; }
.file-icon { color: var(--color-text-muted); }
.entry-name {
  min-width: 0; flex: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--color-text-primary);
}
.dir-row:hover .entry-name { color: var(--color-accent-primary); }
.entry-size { flex-shrink: 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.empty-state { padding: 2rem; text-align: center; }

/* R2 operation buttons */
.op-btn {
  flex-shrink: 0;
  background: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  padding: 0.15rem 0.45rem;
  font-size: var(--fs-xs);
  cursor: pointer;
  color: var(--color-text-muted);
  opacity: 0.55;
  transition: all 0.1s;
  line-height: 1.4;
}
.entry-row:hover .op-btn { opacity: 1; }
.op-btn:hover { color: var(--color-text-primary); border-color: var(--color-border-default); background: var(--color-bg-tertiary); }
.op-delete:hover { color: var(--color-status-error); border-color: var(--color-status-error); }
.op-confirm:hover { color: var(--color-status-success); border-color: var(--color-status-success); }
.op-confirm, .op-cancel { opacity: 1; }

.rename-input {
  flex: 1;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-accent-primary);
  border-radius: 2px;
  padding: 0.2rem 0.5rem;
  color: var(--color-text-primary);
  outline: none;
}

.field-hint {
  display: block;
  margin-top: 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}

/* 042 — tidy folder modal */
.tidy-modal { width: min(720px, 94vw); max-height: 90vh; overflow-y: auto; }
.dry-run-row {
  display: flex; align-items: center; gap: 0.5rem;
  margin-top: 0.75rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.tidy-plan { margin-top: 0.85rem; }
.tidy-plan-title { color: var(--color-accent-primary); margin-bottom: 0.4rem; }
.tidy-plan-list {
  max-height: 45vh;
  overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
  padding: 0.4rem;
}
.tidy-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 0.5rem;
  align-items: center;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--fs-xs);
}
.tidy-row:last-child { border-bottom: none; }
.tidy-from { color: var(--color-text-muted); word-break: break-all; }
.tidy-arrow { color: var(--color-accent-primary); font-family: var(--font-mono); }
.tidy-to { color: var(--color-text-primary); word-break: break-all; }
.te-msg {
  margin-top: 0.6rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-status-success);
}
.te-msg.error { color: var(--color-status-error); }

/* 056 — Work-queue HUD: progress bar + chips + failed-list panel. */
.work-queue-card { margin-bottom: 1.25rem; padding: 0.85rem 1rem; }
.work-queue-card .card-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0.6rem;
}
.wq-actions { display: flex; gap: 0.4rem; align-items: center; }
.wq-toggle {
  font-family: var(--font-mono); font-size: var(--fs-xs);
  letter-spacing: 0.08em;
  padding: 0.2rem 0.7rem;
}
.wq-toggle.resumed { color: var(--color-status-success); border-color: var(--color-status-success); }

.wq-progress-line {
  display: flex; align-items: center; justify-content: space-between;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  margin-bottom: 0.4rem;
}
.wq-progress-text { color: var(--color-text-primary); }
.wq-speed {
  color: var(--color-accent-primary);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
}

.wq-progress-bar {
  height: 6px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}
.wq-progress-fill {
  height: 100%;
  background: var(--color-accent-primary);
  transition: width 0.3s ease;
}

.wq-current {
  color: var(--color-accent-primary);
  font-size: var(--fs-xs);
  margin-bottom: 0.4rem;
  animation: pulse 2s ease-in-out infinite;
}

.wq-paused-hint {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  margin: 0.2rem 0 0.5rem 0;
}

.wq-recent { margin-top: 0.6rem; }
.wq-recent-label { color: var(--color-text-muted); margin-bottom: 0.35rem; }
.wq-recent-list {
  display: flex; gap: 0.4rem; flex-wrap: wrap;
}
.wq-recent-chip {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.2rem 0.55rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  background: var(--color-bg-secondary);
  max-width: 16rem;
}
.wq-recent-chip.wq-ok { color: var(--color-text-secondary); }
.wq-recent-chip.wq-fail {
  color: var(--color-status-error);
  border-color: var(--color-status-error);
}
.wq-chip-icon { flex-shrink: 0; font-weight: bold; }
.wq-chip-name {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}

.wq-failed {
  margin-top: 0.85rem;
  border-top: 1px solid var(--color-border-subtle);
  padding-top: 0.7rem;
}
.wq-failed-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0.4rem;
}
.wq-failed-header .mono-label { color: var(--color-status-error); }
.wq-refresh {
  font-family: var(--font-mono); font-size: var(--fs-xs);
  padding: 0.15rem 0.5rem;
}
.wq-failed-list {
  display: flex; flex-direction: column; gap: 0.25rem;
  max-height: 12rem; overflow-y: auto;
}
.wq-failed-row {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.3rem 0.4rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  border-left: 2px solid var(--color-status-error);
  border-radius: 2px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
.wq-failed-text {
  flex: 1; min-width: 0;
  color: var(--color-text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wq-cancel {
  opacity: 1;
  color: var(--color-text-muted);
}
.wq-cancel:hover {
  color: var(--color-status-error);
  border-color: var(--color-status-error);
}
.wq-failed-empty {
  font-family: var(--font-mono); font-size: var(--fs-xs);
  color: var(--color-text-muted);
  padding: 0.3rem 0;
}

.wq-error {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-status-error);
  margin-top: 0.4rem;
}
</style>
