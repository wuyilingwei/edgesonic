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
import { useAuth, parseXmlAttrs } from "../api";

const { t } = useI18n();
const { isAdmin, authFetch, authPost } = useAuth();

interface Source { id: string; type: string; base_url: string; username: string; rootPath: string; enabled: boolean; lastSync: string; }

const sources = ref<Source[]>([]);
const showForm = ref(false);
const form = ref({ type: "webdav", base_url: "", username: "", password: "", root_path: "" });
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

// === Edit modal ===
const editing = ref<Source | null>(null);
const editForm = ref({ base_url: "", username: "", password: "", root_path: "", enabled: true });

function openEdit(s: Source) {
  editing.value = s;
  editForm.value = { base_url: s.base_url, username: s.username, password: "", root_path: s.rootPath, enabled: s.enabled };
}
function closeEdit() { editing.value = null; }

async function saveEdit() {
  if (!editing.value) return;
  const s = editing.value;
  const body: Record<string, unknown> = { id: s.id };
  if (editForm.value.base_url !== s.base_url) body.base_url = editForm.value.base_url;
  if (editForm.value.username !== s.username) body.username = editForm.value.username;
  if (editForm.value.password) body.password = editForm.value.password; // 留空 = 不修改
  if (editForm.value.root_path !== s.rootPath) body.root_path = editForm.value.root_path;
  if (editForm.value.enabled !== s.enabled) body.enabled = editForm.value.enabled ? 1 : 0;
  try {
    const xml = await authPost("updateStorageSource", body);
    if (/status="failed"/.test(xml)) throw new Error("update failed");
    closeEdit(); load(); showToast(t("sources.updated"));
  } catch { showToast(t("sources.updateFailed"), "error"); }
}

async function load() {
  try {
    const xml = await authFetch("getStorageSources");
    sources.value = parseXmlAttrs(xml, "source").map((s) => ({
      id: s.id || "", type: s.type || "", base_url: s.baseUrl || "",
      username: s.username || "", rootPath: s.rootPath || "",
      enabled: s.enabled === "1",
      lastSync: s.lastSync || "Never",
    }));
  } catch { sources.value = []; }
}

async function addSource() {
  try { await authPost("addStorageSource", form.value); showForm.value = false; load(); showToast(t("sources.added")); }
  catch { showToast(t("sources.addFailed"), "error"); }
}

async function deleteSource(id: string) {
  if (!confirm(t("sources.deleteConfirm"))) return;
  try { await authPost("deleteStorageSource", { id }); load(); showToast(t("sources.deleted")); }
  catch { showToast(t("sources.deleteFailed"), "error"); }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("sources.label") }}</div>
        <h1 class="page-title">{{ t("sources.title") }}</h1>
      </div>
      <button v-if="isAdmin" :class="showForm ? 'btn-secondary' : 'btn-primary'" @click="showForm = !showForm">{{ showForm ? t("common.cancel") : t("sources.add") }}</button>
    </div>

    <div v-if="showForm" class="card" style="margin-bottom:1.25rem; max-width:500px">
      <div class="card-header"><span class="card-title">{{ t("sources.newSource") }}</span></div>
      <div style="display:flex; flex-direction:column; gap:0.8rem">
        <div class="form-group">
          <label class="form-label">{{ t("sources.type") }}</label>
          <select v-model="form.type" class="form-select"><option value="webdav">WebDAV</option><option value="subsonic">Subsonic</option></select>
        </div>
        <div class="form-group"><label class="form-label">{{ t("sources.baseUrl") }}</label><input v-model="form.base_url" class="form-input" placeholder="https://..." /></div>
        <div class="form-group"><label class="form-label">{{ t("sources.username") }}</label><input v-model="form.username" class="form-input" /></div>
        <div class="form-group"><label class="form-label">{{ t("sources.password") }}</label><input v-model="form.password" type="password" class="form-input" /></div>
        <div class="form-group">
          <label class="form-label">{{ t("sources.rootPath") }}</label>
          <input v-model="form.root_path" class="form-input" placeholder="/music" />
          <span class="field-hint">{{ t("sources.rootPathHint") }}</span>
        </div>
        <button class="btn-primary" @click="addSource">{{ t("sources.save") }}</button>
      </div>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <div class="grid grid-2">
      <div v-for="s in sources" :key="s.id" class="card hoverable source-card">
        <div class="source-header">
          <div class="source-badges">
            <span class="status-badge info">{{ s.type.toUpperCase() }}</span>
            <span :class="['status-badge', s.enabled ? 'success' : 'error']">{{ s.enabled ? t("sources.active") : t("sources.disabled") }}</span>
          </div>
          <div v-if="isAdmin" class="source-actions">
            <button class="btn-secondary btn-sm" @click="openEdit(s)">{{ t("common.edit") }}</button>
            <button class="btn-danger btn-sm" @click="deleteSource(s.id)">{{ t("common.delete") }}</button>
          </div>
        </div>
        <div class="source-url">{{ s.base_url }}</div>
        <div class="source-meta">
          <span v-if="s.username">{{ t("sources.user") }}: {{ s.username }}</span>
          <span v-if="s.rootPath">{{ t("sources.root") }}: {{ s.rootPath }}</span>
          <span v-if="s.lastSync !== 'Never'">{{ t("sources.lastSync") }}: {{ s.lastSync }}</span>
          <span v-else class="text-muted">{{ t("sources.notSynced") }}</span>
        </div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <div v-if="!sources.length" class="empty-state" style="grid-column:1/-1">
        <div class="empty-state-icon">◌</div><div>{{ t("sources.empty") }}</div>
      </div>
    </div>

    <!-- Edit modal -->
    <div v-if="editing" class="modal-backdrop" @click.self="closeEdit">
      <div class="modal">
        <div class="modal-title">{{ t("sources.editSource") }}</div>
        <div style="display:flex; flex-direction:column; gap:0.8rem">
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
          <div class="form-group enabled-row">
            <label class="form-label" style="margin-bottom:0">{{ t("sources.enabled") }}</label>
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
.source-card { display: flex; flex-direction: column; gap: 0.7rem; }
.source-header { display: flex; align-items: center; justify-content: space-between; }
.source-badges { display: flex; gap: 0.4rem; }
.source-actions { display: flex; gap: 0.4rem; }
.source-url {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-accent-primary);
  word-break: break-all;
}
.source-meta {
  display: flex; gap: 1rem; flex-wrap: wrap;
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
</style>
