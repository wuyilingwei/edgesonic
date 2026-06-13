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
import { useAuth, parseXmlAttrs, formatSize } from "../api";
import TagEditor from "../components/TagEditor.vue";
import ScrapeButton from "../components/ScrapeButton.vue";
import type { ScrapeResult } from "../lib/scrape";
import { extractMetadata, isBrowserParse, suffixOf } from "../lib/metadata";

const { t } = useI18n();
const { authFetch, authPost, uploadFile, writeTags, submitMetadata, tidyFolder, restUrl, level } = useAuth();

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

// Upload state
const showUpload = ref(false);
const uploadFileRef = ref<File | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null);
const uploadBusy = ref(false);
const uploadMsg = ref("");
const uploadErr = ref(false);

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
    const xml = await authFetch("getStorageSources");
    sources.value = parseXmlAttrs(xml, "source")
      .filter((s) => s.enabled === "true" || s.enabled === "1")
      .map((s) => ({ id: s.id || "", type: s.type || "", name: s.name || "", baseUrl: s.baseUrl || "" }));
  } catch { sources.value = []; }
}

async function loadDir() {
  loading.value = true;
  renamingFile.value = null;
  try {
    const text = await authFetch("listFiles", { source: currentSource.value, path: path.value });
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
}

function enterDir(name: string) {
  path.value = path.value ? `${path.value}/${name}` : name;
  loadDir();
}

function goCrumb(index: number) {
  path.value = index < 0 ? "" : crumbs.value.slice(0, index + 1).join("/");
  loadDir();
}

function onUploadFile(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files?.length) uploadFileRef.value = target.files[0];
}

async function doUpload() {
  if (!uploadFileRef.value) { uploadMsg.value = t("files.selectFileFirst"); uploadErr.value = true; return; }
  uploadBusy.value = true;
  uploadMsg.value = t("files.uploading");
  uploadErr.value = false;
  try {
    await uploadFile(uploadFileRef.value, uploadTarget.value, path.value || undefined);
    showToast(t("files.uploaded"));
    uploadFileRef.value = null;
    if (uploadInput.value) uploadInput.value.value = "";
    uploadMsg.value = "";
    loadDir();
  } catch {
    uploadMsg.value = t("files.uploadFailed");
    uploadErr.value = true;
    showToast(t("files.uploadFailed"), "error");
  } finally {
    uploadBusy.value = false;
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
      const text = await authFetch("scanTags", { batch: "4" });
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

// 041: walk the visible directory and process every browser-parseable file.
// Each file: resolve instance_id by storage_uri → fetch via /rest/stream
// (auth-signed) → music-metadata parse → POST /rest/submitMetadata.
async function runBrowserRead() {
  if (browserScanning.value) return;
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
        // 1. uri → instance_id
        const lookup = JSON.parse(await authFetch("findInstanceByUri", { uri: f.uri }));
        if (!lookup?.ok || !lookup.instanceId || !lookup.masterId) continue;
        // 2. download via /rest/stream — gives us a proper authed audio blob
        const resp = await fetch(restUrl("stream", { id: lookup.masterId }));
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const file = new File([blob], f.name, { type: f.contentType || blob.type });
        // 3. parse
        const meta = await extractMetadata(file);
        // 4. submit
        const submit = await submitMetadata(lookup.instanceId, meta as Record<string, string | number>);
        if (submit.ok) browserScanTagged.value++;
      } catch { /* per-file failures don't poison the batch */ }
    }
    showToast(t("files.browserReadDone", { tagged: browserScanTagged.value, total: targets.length }));
  } finally {
    browserScanning.value = false;
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
    const res = await authPost("files/move", { key: fromKey, dest: toKey });
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
    const res = await authPost(endpoint, { key: fromKey, dest: toKey });
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
    const res = await authPost("files/delete", { key });
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
  loadDir();
});
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
        <button v-if="canScan" class="btn-secondary" :disabled="scanning || browserScanning" @click="runTagScan">{{ t("files.scanTags") }}</button>
        <button v-if="canScan" class="btn-secondary" :disabled="scanning || browserScanning" @click="runBrowserRead">{{ t("files.browserRead") }}</button>
        <button v-if="canTidy" class="btn-secondary" :disabled="scanning || browserScanning || tidyBusy" @click="openTidyFolder">{{ t("files.tidy") }}</button>
        <button v-if="canUpload" class="btn-primary" @click="showUpload = !showUpload">{{ t("files.upload") }}</button>
      </div>
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
          <input ref="uploadInput" type="file" accept="audio/*" class="form-input" @change="onUploadFile" />
        </div>
        <button class="btn-primary" :disabled="!uploadFileRef || uploadBusy" @click="doUpload">{{ t("files.uploadBtn") }}</button>
      </div>
      <p v-if="uploadMsg" :class="['upload-msg', { error: uploadErr }]">{{ uploadMsg }}</p>
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
  opacity: 0;
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
</style>
