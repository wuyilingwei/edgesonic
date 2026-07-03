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
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";

const { t } = useI18n();
const { isAdmin, isSuperAdmin, storageFetch, storagePost } = useAuth();

type ScanState = "idle" | "running" | "completed" | "failed";

interface ScanJobSnapshot {
  jobId: string;
  status: ScanState;
  total: number;
  scanned: number;
  startedAt: number;       // unix seconds
  endedAt: number | null;
  error: string | null;
}

interface Source {
  id: string;
  type: string;
  name: string;
  base_url: string;
  username: string;
  rootPath: string;
  enabled: boolean;
  lastSync: string;
  // 068 — true iff the row's password_encrypted column holds a `v1:` AES-GCM
  // blob; false for legacy plaintext or rows where the password column itself
  // is empty (e.g. r2 / url sources, which never had a password).
  encrypted: boolean;
  // P4 — library=扫描时入库; sync_only=仅作复制/同步目标，扫描不入库
  mode: "library" | "sync_only";
  // 060 — Last scan_jobs row snapshot for this source. Populated by
  // pollScanStatus() so the action column can render idle/running/completed/
  // failed without an extra round-trip per row.
  scanStatus: ScanState;
  scanJobId: string | null;
  scanTotal: number;
  scanScanned: number;
  scanStartedAt: number;   // 0 = unknown
  scanEndedAt: number | null;
  scanError: string | null;
}

const sources = ref<Source[]>([]);
// P3 — loading guard for initial fetch
const loading = ref(false);
const showForm = ref(false);
const form = ref({ type: "webdav", name: "", base_url: "", username: "", password: "", root_path: "", mode: "library" });
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

// === 060 — Scan polling + history ===
// In-memory history: scan_jobs we've observed during this session. Keyed by
// source id, capped at 5 entries (newest first). We deliberately don't add a
// /storage/scan/history endpoint (task scope says "don't extend endpoints"),
// so the array only grows from /storage/scan/status snapshots seen while the
// page is mounted. That's enough for the common "user clicks scan → watches
// progress" loop; cron-triggered scans that finish while the user is on
// another page won't appear here.
const HISTORY_CAP = 5;
const scanHistory = ref<Record<string, ScanJobSnapshot[]>>({});
const expandedSources = ref<Set<string>>(new Set());
const pollHandle = ref<number | null>(null);
// P6: reduced from 3000ms — less aggressive polling
const POLL_INTERVAL_MS = 8000;
const STATUS_LAUNCHING = "__launching__"; // placeholder while scan/start hasn't yet returned
const launching = ref<Set<string>>(new Set());

const anyRunning = computed(() => sources.value.some((s) => s.scanStatus === "running") || launching.value.size > 0);

function toggleHistory(id: string) {
  const set = new Set(expandedSources.value);
  if (set.has(id)) set.delete(id); else set.add(id);
  expandedSources.value = set;
}

function recordHistory(sourceId: string, snap: ScanJobSnapshot) {
  const list = scanHistory.value[sourceId] ? [...scanHistory.value[sourceId]] : [];
  const existing = list.findIndex((j) => j.jobId === snap.jobId);
  if (existing >= 0) {
    list[existing] = snap;
  } else {
    list.unshift(snap);
    if (list.length > HISTORY_CAP) list.length = HISTORY_CAP;
  }
  // Sort by startedAt desc so newly inserted jobs land at the top regardless
  // of insert order (server-side ties are possible during fast retries).
  list.sort((a, b) => b.startedAt - a.startedAt);
  scanHistory.value = { ...scanHistory.value, [sourceId]: list };
}

function parseScanState(raw: string): ScanState {
  if (raw === "running" || raw === "completed" || raw === "failed") return raw;
  return "idle";
}

async function pollScanStatus() {
  try {
    const xml = await storageFetch("scan/status");
    const rows = parseXmlAttrs(xml, "source");
    if (!rows.length) return;
    // Map source.id → latest job row
    const byId = new Map<string, Record<string, string>>();
    for (const r of rows) if (r.id) byId.set(r.id, r);

    sources.value = sources.value.map((s) => {
      const r = byId.get(s.id);
      if (!r) return s;
      const status = parseScanState(r.status || "idle");
      const snap: ScanJobSnapshot = {
        jobId: r.jobId || "",
        status,
        total: parseInt(r.total || "0", 10) || 0,
        scanned: parseInt(r.scanned || "0", 10) || 0,
        startedAt: parseInt(r.startedAt || "0", 10) || 0,
        endedAt: r.endedAt ? parseInt(r.endedAt, 10) || null : null,
        error: r.error || null,
      };
      if (snap.jobId) recordHistory(s.id, snap);
      // If status flipped from running → completed, refresh last_sync.
      const flippedDone = s.scanStatus === "running" && status === "completed";
      if (flippedDone) {
        // Best-effort: re-pull /sources/list in background to refresh lastSync.
        load();
      }
      // Clear the launching marker once the server confirms a job exists.
      if (snap.jobId) launching.value.delete(s.id);
      return {
        ...s,
        scanStatus: status,
        scanJobId: snap.jobId || s.scanJobId,
        scanTotal: snap.total,
        scanScanned: snap.scanned,
        scanStartedAt: snap.startedAt || s.scanStartedAt,
        scanEndedAt: snap.endedAt,
        scanError: snap.error,
      };
    });
  } catch {
    // Network blip: keep current state, wait for next tick.
  }
}

function startPolling() {
  if (pollHandle.value !== null) return;
  pollHandle.value = window.setInterval(async () => {
    await pollScanStatus();
    if (!anyRunning.value) stopPolling();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollHandle.value !== null) {
    clearInterval(pollHandle.value);
    pollHandle.value = null;
  }
}

// P6 — pause polling when tab hidden, resume when visible
function handleVisibilityChange() {
  if (document.hidden) {
    stopPolling();
  } else {
    if (anyRunning.value) {
      pollScanStatus();
      startPolling();
    }
  }
}

// === Edit modal ===
const editing = ref<Source | null>(null);
const editForm = ref({ name: "", base_url: "", username: "", password: "", root_path: "", enabled: true, mode: "library" as "library" | "sync_only" });

function openEdit(s: Source) {
  editing.value = s;
  editForm.value = { name: s.name, base_url: s.base_url, username: s.username, password: "", root_path: s.rootPath, enabled: s.enabled, mode: s.mode };
}
function closeEdit() { editing.value = null; }

async function saveEdit() {
  if (!editing.value) return;
  const s = editing.value;
  const body: Record<string, unknown> = { id: s.id };
  if (editForm.value.name !== s.name) body.name = editForm.value.name;
  if (editForm.value.base_url !== s.base_url) body.base_url = editForm.value.base_url;
  if (editForm.value.username !== s.username) body.username = editForm.value.username;
  if (editForm.value.password) body.password = editForm.value.password;
  if (editForm.value.root_path !== s.rootPath) body.root_path = editForm.value.root_path;
  if (editForm.value.enabled !== s.enabled) body.enabled = editForm.value.enabled ? 1 : 0;
  if (editForm.value.mode !== s.mode) body.mode = editForm.value.mode;
  try {
    const xml = await storagePost("sources/update", body);
    if (/status="failed"/.test(xml)) throw new Error("update failed");
    closeEdit(); load(); showToast(t("sources.updated"));
  } catch { showToast(t("sources.updateFailed"), "error"); }
}

async function load() {
  // P3: show loading spinner on initial fetch (skip if sources already loaded)
  if (!sources.value.length) loading.value = true;
  try {
    const xml = await storageFetch("sources/list");
    const prevById = new Map(sources.value.map((s) => [s.id, s]));
    sources.value = parseXmlAttrs(xml, "source").map((s) => {
      const id = s.id || "";
      const prev = prevById.get(id);
      return {
        id,
        type: s.type || "",
        name: s.name || "",
        base_url: s.baseUrl || "",
        username: s.username || "",
        rootPath: s.rootPath || "",
        enabled: s.enabled === "true" || s.enabled === "1",
        lastSync: s.lastSync && s.lastSync !== "0" ? new Date(parseInt(s.lastSync) * 1000).toLocaleString() : "Never",
        // 068 — sources/list emits encrypted="true"|"false". Only webdav /
        // subsonic rows ever flip to true; r2 / url stay false.
        encrypted: s.encrypted === "true",
        // P4 — mode defaults to "library" when attribute is absent
        mode: (s.mode === "sync_only" ? "sync_only" : "library") as "library" | "sync_only",
        scanStatus: prev?.scanStatus ?? "idle",
        scanJobId: prev?.scanJobId ?? null,
        scanTotal: prev?.scanTotal ?? 0,
        scanScanned: prev?.scanScanned ?? 0,
        scanStartedAt: prev?.scanStartedAt ?? 0,
        scanEndedAt: prev?.scanEndedAt ?? null,
        scanError: prev?.scanError ?? null,
      };
    });
  } catch { sources.value = []; } finally {
    loading.value = false;
  }
}

async function addSource() {
  try { await storagePost("sources/add", form.value); showForm.value = false; load(); showToast(t("sources.added")); }
  catch { showToast(t("sources.addFailed"), "error"); }
}

async function deleteSource(id: string) {
  if (!confirm(t("sources.deleteConfirm"))) return;
  try { await storagePost("sources/delete", { id }); load(); showToast(t("sources.deleted")); }
  catch { showToast(t("sources.deleteFailed"), "error"); }
}

async function scanSource(s: Source, force = false) {
  // 060 — flip to a launching placeholder so the row immediately shows a
  // spinner instead of staying on "Scan". The 1st pollScanStatus() will
  // replace this with the real running snapshot (jobs are inserted
  // synchronously inside scan/start before the response returns, see
  // worker/src/endpoints/storage/scan.ts:50-107).
  // 076 — `force` (Shift+click) bypasses the ETag short-circuit on the worker
  // side so every existing instance gets an UPDATE + tag_scanned=0 reset. This
  // gives the user a way to say "I know nothing changed metadata-wise but
  // re-run the metadata pipeline anyway" — the common-case incremental scan
  // would otherwise return instantly and feel like the button did nothing.
  launching.value.add(s.id);
  // Optimistically mark the row as running so the badge updates without
  // waiting for the next poll tick.
  sources.value = sources.value.map((x) => x.id === s.id
    ? { ...x, scanStatus: "running" as ScanState, scanScanned: 0, scanTotal: 0, scanError: null }
    : x);
  try {
    const params: Record<string, string> = { id: s.id };
    if (force) params.force = "1";
    const xml = await storageFetch("scan/start", params);
    const res = parseXmlAttrs(xml, "source")[0];
    if (!res) throw new Error("no scan job created");
    if (res.error) throw new Error(res.error);
    showToast(force ? t("sources.scanStatus.forceStartToast") : t("sources.scanStatus.startToast"));
    // Pull status right away so the X/Y counter starts moving.
    await pollScanStatus();
    startPolling();
  } catch (e) {
    launching.value.delete(s.id);
    sources.value = sources.value.map((x) => x.id === s.id
      ? { ...x, scanStatus: "failed" as ScanState, scanError: e instanceof Error ? e.message : String(e) }
      : x);
    showToast(t("sources.scanFailed") + (e instanceof Error && e.message !== "scan failed" ? `: ${e.message}` : ""), "error");
  }
}

// --- Display helpers ---
function relativeTime(ts: number): string {
  if (!ts) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - ts);
  if (diff < 10) return t("sources.scanStatus.relative.justNow");
  if (diff < 60) return t("sources.scanStatus.relative.secondsAgo", { n: diff });
  if (diff < 3600) return t("sources.scanStatus.relative.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("sources.scanStatus.relative.hoursAgo", { n: Math.floor(diff / 3600) });
  return t("sources.scanStatus.relative.daysAgo", { n: Math.floor(diff / 86400) });
}

function formatDuration(startedAt: number, endedAt: number | null): string {
  if (!startedAt) return "—";
  const end = endedAt || Math.floor(Date.now() / 1000);
  const diff = Math.max(0, end - startedAt);
  if (diff < 60) return t("sources.scanStatus.durationSeconds", { n: diff });
  return t("sources.scanStatus.durationMinutes", { n: Math.floor(diff / 60) });
}

function formatStarted(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function statusLabel(s: Source): string {
  if (s.scanStatus === "running") {
    if (s.scanTotal > 0) return t("sources.scanStatus.running", { scanned: s.scanScanned, total: s.scanTotal });
    return t("sources.scanStatus.runningUnknown");
  }
  if (s.scanStatus === "completed") {
    return t("sources.scanStatus.completed", {
      total: s.scanTotal,
      relative: relativeTime(s.scanEndedAt || s.scanStartedAt),
    });
  }
  if (s.scanStatus === "failed") return t("sources.scanStatus.failed");
  return t("sources.scanStatus.idle");
}

// === 068 — bulk-encrypt legacy plaintext passwords ===
// Super-admin only. The button is hidden for plain admins so the one-way
// nature of the action stays out of the regular admin's foot-gun surface.
// We don't pre-check STORAGE_KEY availability on the client because:
//   1. The endpoint already returns ok:false + error when the secret is unset.
//   2. Probing would leak whether a secret is configured to anyone who can
//      reach the page.
const migrating = ref(false);
async function migratePasswords() {
  if (migrating.value) return;
  if (!confirm(t("sources.migrateConfirm"))) return;
  migrating.value = true;
  try {
    const xml = await storagePost("sources/migratePasswords", {});
    // The endpoint emits JSON (the rest of /storage/ is JSON-shaped), but
    // storagePost returns the body as text. Parse it; if it doesn't look like
    // JSON, surface a generic failure.
    let body: { ok?: boolean; migrated?: number; failed?: number; total?: number; error?: string };
    try { body = JSON.parse(xml); }
    catch { showToast(t("sources.migrateFailed"), "error"); return; }
    if (!body.ok) {
      showToast(body.error || t("sources.migrateFailed"), "error");
      return;
    }
    if ((body.total ?? 0) === 0) {
      showToast(t("sources.migrateNoneed"));
    } else {
      showToast(t("sources.migrateSuccess", {
        migrated: body.migrated ?? 0,
        failed: body.failed ?? 0,
      }));
    }
    await load();
  } catch {
    showToast(t("sources.migrateFailed"), "error");
  } finally {
    migrating.value = false;
  }
}

onMounted(async () => {
  await load();
  await pollScanStatus();
  if (anyRunning.value) startPolling();
  // P6: pause/resume polling on tab visibility changes
  document.addEventListener("visibilitychange", handleVisibilityChange);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("sources.label") }}</div>
        <h1 class="page-title">{{ t("sources.title") }}</h1>
      </div>
      <div class="page-header-actions">
        <!-- 068 — super-admin only one-way bulk encrypt. Hidden behind
             confirm() to avoid an accidental click trashing the legacy
             password column before STORAGE_KEY is verified. -->
        <button
          v-if="isSuperAdmin"
          class="btn-secondary"
          :disabled="migrating"
          :title="t('sources.migrateHint')"
          @click="migratePasswords"
        >{{ migrating ? t("sources.migrating") : t("sources.migratePasswords") }}</button>
        <button v-if="isAdmin" :class="showForm ? 'btn-secondary' : 'btn-primary'" @click="showForm = !showForm">{{ showForm ? t("common.cancel") : t("sources.add") }}</button>
      </div>
    </div>

    <!-- P5: use class instead of inline style; width matches grid columns -->
    <div v-if="showForm" class="card source-form">
      <div class="card-header"><span class="card-title">{{ t("sources.newSource") }}</span></div>
      <div class="form-stack">
        <div class="form-group">
          <label class="form-label">{{ t("sources.type") }}</label>
          <select v-model="form.type" class="form-select"><option value="webdav">WebDAV</option><option value="subsonic">Subsonic</option></select>
        </div>
        <div class="form-group"><label class="form-label">{{ t("sources.alias") }}</label><input v-model="form.name" class="form-input" :placeholder="t('sources.aliasPlaceholder')" /></div>
        <div class="form-group"><label class="form-label">{{ t("sources.baseUrl") }}</label><input v-model="form.base_url" class="form-input" placeholder="https://..." /></div>
        <div class="form-group"><label class="form-label">{{ t("sources.username") }}</label><input v-model="form.username" class="form-input" /></div>
        <div class="form-group"><label class="form-label">{{ t("sources.password") }}</label><input v-model="form.password" type="password" class="form-input" /></div>
        <div class="form-group">
          <label class="form-label">{{ t("sources.rootPath") }}</label>
          <input v-model="form.root_path" class="form-input" placeholder="/music" />
          <span class="field-hint">{{ t("sources.rootPathHint") }}</span>
        </div>
        <!-- P4: mode selector -->
        <div class="form-group">
          <label class="form-label">{{ t("sources.mode.label") }}</label>
          <select v-model="form.mode" class="form-select">
            <option value="library">{{ t("sources.mode.library") }}</option>
            <option value="sync_only">{{ t("sources.mode.syncOnly") }}</option>
          </select>
          <span class="field-hint">{{ t("sources.mode.hint") }}</span>
        </div>
        <button class="btn-primary" @click="addSource">{{ t("sources.save") }}</button>
      </div>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <!-- P3: loading state -->
    <div v-if="loading" class="loading-state">{{ t("common.loading") }}</div>
    <div v-else class="grid grid-2">
      <div v-for="s in sources" :key="s.id" class="card hoverable source-card">
        <!-- Top row: type badge (left) + badges + actions (right) -->
        <div class="source-header">
          <span class="status-badge info">{{ s.type.toUpperCase() }}</span>
          <!-- P5: split into stable badge group + action group -->
          <div class="source-right">
            <!-- Badge row -->
            <div class="source-badges">
              <!-- 068 — encrypted/plaintext badge -->
              <span
                v-if="(s.type === 'webdav' || s.type === 'subsonic') && isAdmin"
                :class="['status-badge', s.encrypted ? 'success' : 'warn']"
                :title="s.encrypted ? t('sources.passwordEncryptedHint') : t('sources.passwordPlaintextHint')"
              >{{ s.encrypted ? t("sources.passwordEncrypted") : t("sources.passwordPlaintext") }}</span>
              <span :class="['status-badge', s.enabled ? 'success' : 'error']">{{ s.enabled ? t("sources.active") : t("sources.disabled") }}</span>
              <!-- P4: mode badge — only shown for sync_only, library is the default/silent state -->
              <span v-if="s.mode === 'sync_only'" class="status-badge mode-sync" :title="t('sources.mode.hint')">{{ t("sources.mode.syncOnly") }}</span>
              <!-- 060: scan status pill (display only — buttons are in source-actions below) -->
              <template v-if="isAdmin && s.type === 'webdav'">
                <span v-if="s.scanStatus === 'running'" class="scan-pill scan-pill-running" :title="t('sources.scanStatus.progress')">
                  <span class="scan-spinner" aria-hidden="true"></span>
                  <span class="scan-pill-text">{{ statusLabel(s) }}</span>
                </span>
                <span v-else-if="s.scanStatus === 'completed'" class="scan-pill scan-pill-completed" :title="t('sources.scanStatus.completed', { total: s.scanTotal, relative: relativeTime(s.scanEndedAt || s.scanStartedAt) })">
                  <span class="scan-icon" aria-hidden="true">✓</span>
                  <span class="scan-pill-text">{{ statusLabel(s) }}</span>
                </span>
                <span v-else-if="s.scanStatus === 'failed'" class="scan-pill scan-pill-failed" :title="s.scanError || ''">
                  <span class="scan-icon" aria-hidden="true">✗</span>
                  <span class="scan-pill-text">{{ s.scanError ? `${t('sources.scanStatus.failed')} — ${s.scanError}` : t("sources.scanStatus.failed") }}</span>
                </span>
              </template>
            </div>
            <!-- Action row -->
            <div v-if="isAdmin" class="source-actions">
              <!-- P5/P10: scan buttons moved out of pill; rescan has own i18n key -->
              <template v-if="s.type === 'webdav' && s.scanStatus !== 'running'">
                <button
                  :class="s.scanStatus === 'idle' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'"
                  :title="t('sources.scanStatus.forceHint')"
                  @click="scanSource(s, $event.shiftKey)"
                >
                  {{ s.scanStatus === 'completed' ? t('sources.scanStatus.rescan') : s.scanStatus === 'failed' ? t('sources.scanStatus.retry') : t('sources.scanStatus.idle') }}
                </button>
              </template>
              <button class="btn-secondary btn-sm" @click="openEdit(s)">{{ t("common.edit") }}</button>
              <button class="btn-danger btn-sm" @click="deleteSource(s.id)">{{ t("common.delete") }}</button>
            </div>
          </div>
        </div>
        <!-- Alias / display name -->
        <div class="source-name">{{ s.name || s.base_url }}</div>
        <!-- URL (shown when alias is set) -->
        <div v-if="s.name" class="source-url">{{ s.base_url }}</div>
        <div class="source-meta">
          <span v-if="s.username">{{ t("sources.user") }}: {{ s.username }}</span>
          <span v-if="s.rootPath">{{ t("sources.root") }}: {{ s.rootPath }}</span>
          <span v-if="s.lastSync !== 'Never'">{{ t("sources.lastSync") }}: {{ s.lastSync }}</span>
          <span v-else class="text-muted">{{ t("sources.notSynced") }}</span>
        </div>
        <!-- 060: scan history toggle (webdav only) -->
        <div v-if="s.type === 'webdav'" class="scan-history-toggle">
          <button class="link-button" @click="toggleHistory(s.id)">
            {{ expandedSources.has(s.id) ? t("sources.scanStatus.collapse") : t("sources.scanStatus.expand") }}
            <span class="mono-subtle">[{{ (scanHistory[s.id] || []).length }}]</span>
          </button>
        </div>
        <div v-if="s.type === 'webdav' && expandedSources.has(s.id)" class="scan-history">
          <div class="scan-history-title">{{ t("sources.scanStatus.history") }}</div>
          <div v-if="!(scanHistory[s.id] && scanHistory[s.id].length)" class="scan-history-empty">{{ t("sources.scanStatus.historyEmpty") }}</div>
          <table v-else class="scan-history-table">
            <thead>
              <tr>
                <th>{{ t("sources.scanStatus.jobId") }}</th>
                <th>{{ t("sources.scanStatus.status") }}</th>
                <th>{{ t("sources.scanStatus.started") }}</th>
                <th>{{ t("sources.scanStatus.progress") }}</th>
                <th>{{ t("sources.scanStatus.duration") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="j in scanHistory[s.id]" :key="j.jobId">
                <td class="mono-cell">{{ j.jobId }}</td>
                <td>
                  <span :class="['status-badge', j.status === 'completed' ? 'success' : j.status === 'failed' ? 'error' : 'info']">{{ j.status }}</span>
                </td>
                <td class="mono-cell">{{ formatStarted(j.startedAt) }}</td>
                <td class="mono-cell">{{ j.scanned }} / {{ j.total }}</td>
                <td class="mono-cell">{{ formatDuration(j.startedAt, j.endedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <!-- P3: empty state only shown after loading completes -->
      <div v-if="!sources.length" class="empty-state" style="grid-column:1/-1">
        <div class="empty-state-icon">◌</div><div>{{ t("sources.empty") }}</div>
      </div>
    </div>

    <!-- Edit modal -->
    <div v-if="editing" class="modal-backdrop" @click.self="closeEdit">
      <div class="modal">
        <div class="modal-title">{{ t("sources.editSource") }}</div>
        <div class="form-stack">
          <div class="form-group"><label class="form-label">{{ t("sources.alias") }}</label><input v-model="editForm.name" class="form-input" :placeholder="t('sources.aliasPlaceholder')" /></div>
          <div class="form-group"><label class="form-label">{{ t("sources.baseUrl") }}</label><input v-model="editForm.base_url" class="form-input" placeholder="https://..." /></div>
          <div class="form-group"><label class="form-label">{{ t("sources.username") }}</label><input v-model="editForm.username" class="form-input" /></div>
          <div class="form-group">
            <label class="form-label">{{ t("sources.password") }}</label>
            <input v-model="editForm.password" type="password" class="form-input" :placeholder="t('sources.passwordKeep')" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("sources.rootPath") }}</label>
            <input v-model="editForm.root_path" class="form-input" placeholder="/music" />
            <span class="field-hint">{{ t("sources.rootPathHint") }}</span>
          </div>
          <!-- P4: mode selector in edit modal -->
          <div class="form-group">
            <label class="form-label">{{ t("sources.mode.label") }}</label>
            <select v-model="editForm.mode" class="form-select">
              <option value="library">{{ t("sources.mode.library") }}</option>
              <option value="sync_only">{{ t("sources.mode.syncOnly") }}</option>
            </select>
            <span class="field-hint">{{ t("sources.mode.hint") }}</span>
          </div>
          <div class="form-group enabled-row">
            <label class="form-label enabled-label">{{ t("sources.enabled") }}</label>
            <label class="toggle">
              <input type="checkbox" v-model="editForm.enabled" />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeEdit">{{ t("common.cancel") }}</button>
          <button class="btn-primary" @click="saveEdit">{{ t("sources.update") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.page { max-width: 1000px; }
.page-header-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

/* 068 — yellow caution variant for the plaintext badge. status-badge already
   provides success/error/info; warn is added inline so we don't have to
   touch palette.css for this task. */
.status-badge.warn {
  background: rgba(234, 179, 8, 0.15);
  color: #facc15;
  border-color: rgba(234, 179, 8, 0.45);
}

/* P4: purple variant for sync_only mode badge */
.status-badge.mode-sync {
  background: rgba(139, 92, 246, 0.15);
  color: #a78bfa;
  border-color: rgba(139, 92, 246, 0.4);
}

/* P3: loading placeholder */
.loading-state {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.1em;
  color: var(--color-text-muted);
  padding: 2.5rem 0;
  text-align: center;
}

/* P5: form card — width aligned with grid-2 column max */
.source-form {
  margin-bottom: 1.25rem;
  max-width: 560px;
}

/* P5: form vertical stack — replaces repeated inline style */
.form-stack {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.source-card { display: flex; flex-direction: column; gap: 0.55rem; }

/* P5: allow the header to wrap gracefully on narrow cards */
.source-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}

/* P5: right side of header — two stable rows (badges | actions) */
.source-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.35rem;
}

/* Badge group: encrypted + enabled + mode + scan-pill */
.source-badges {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* Action group: scan/rescan/retry + edit + delete */
.source-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.source-name {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: 0.01em;
}
.source-url {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-accent-primary);
  word-break: break-all;
}

/* P5: tighter row-gap so wrapped lines don't have uneven spacing */
.source-meta {
  display: flex;
  column-gap: 1rem;
  row-gap: 0.3rem;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.08em;
  color: var(--color-text-secondary);
}

.text-muted { color: var(--color-text-muted); }
.field-hint {
  display: block;
  margin-top: 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}

.enabled-row { display: flex; align-items: center; gap: 0.8rem; }
/* P5: remove inline style="margin-bottom:0" from label inside enabled-row */
.enabled-label { margin-bottom: 0; }

/* 060 — scan status pill (running/completed/failed) */
.scan-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  border: 1px solid var(--color-border, rgba(255,255,255,0.12));
  background: rgba(255, 255, 255, 0.03);
  /* P5: cap pill width so long error text doesn't stretch the card */
  max-width: 240px;
  overflow: hidden;
}
.scan-pill-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scan-pill-running {
  color: var(--color-accent-primary);
  border-color: var(--color-accent-primary);
}
.scan-pill-completed {
  color: var(--color-success, #4ade80);
  border-color: rgba(74, 222, 128, 0.4);
}
.scan-pill-failed {
  color: var(--color-error, #f87171);
  border-color: rgba(248, 113, 113, 0.4);
}
.scan-icon { font-weight: 700; flex-shrink: 0; }
.scan-spinner {
  display: inline-block;
  width: 0.85em;
  height: 0.85em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: scanSpin 0.85s linear infinite;
  flex-shrink: 0;
}
@keyframes scanSpin {
  to { transform: rotate(360deg); }
}

/* 060 — history toggle + table */
.scan-history-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.link-button {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  color: var(--color-accent-primary);
  text-decoration: underline dotted;
}
.link-button:hover { color: var(--color-text-primary); }
.mono-subtle {
  margin-left: 0.3rem;
  color: var(--color-text-muted);
}
.scan-history {
  margin-top: 0.4rem;
  padding: 0.6rem 0.75rem;
  border: 1px dashed var(--color-border, rgba(255,255,255,0.12));
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
}
.scan-history-title {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.1em;
  color: var(--color-text-secondary);
  margin-bottom: 0.4rem;
}
.scan-history-empty {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}
.scan-history-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
.scan-history-table th,
.scan-history-table td {
  text-align: left;
  padding: 0.25rem 0.4rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.scan-history-table th {
  color: var(--color-text-secondary);
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.mono-cell {
  font-family: var(--font-mono);
  color: var(--color-text-primary);
}
</style>
