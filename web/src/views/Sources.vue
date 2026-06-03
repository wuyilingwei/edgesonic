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
import { useAuth, parseXmlAttrs } from "../api";

const { isAdmin, authFetch, authPost } = useAuth();
const sources = ref<Array<{ id: string; type: string; base_url: string; username: string; enabled: boolean; lastSync: string }>>([]);
const showForm = ref(false);
const form = ref({ type: "webdav", base_url: "", username: "", password: "" });
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

async function load() {
  try {
    const xml = await authFetch("getStorageSources");
    sources.value = parseXmlAttrs(xml, "source").map((s) => ({
      id: s.id || "", type: s.type || "", base_url: s.baseUrl || "",
      username: s.username || "", enabled: s.enabled === "1",
      lastSync: s.lastSync || "Never",
    }));
  } catch { sources.value = []; }
}

async function addSource() {
  try { await authPost("addStorageSource", form.value); showForm.value = false; load(); showToast("Source added"); }
  catch { showToast("Failed to add source", "error"); }
}

async function deleteSource(id: string) {
  if (!confirm("Delete this source?")) return;
  try { await authPost("deleteStorageSource", { id }); load(); showToast("Source deleted"); }
  catch { showToast("Failed to delete", "error"); }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1 class="page-title">Storage Sources</h1>
      <button v-if="isAdmin" class="btn btn-primary" @click="showForm = !showForm">{{ showForm ? "Cancel" : "+ Add Source" }}</button>
    </div>

    <div v-if="showForm" class="card" style="margin-bottom:20px; max-width:500px">
      <div class="card-header"><span class="card-title">New Source</span></div>
      <div style="display:flex; flex-direction:column; gap:12px">
        <div class="form-group">
          <label class="form-label">Type</label>
          <select v-model="form.type" class="form-select"><option value="webdav">WebDAV</option><option value="subsonic">Subsonic</option></select>
        </div>
        <div class="form-group"><label class="form-label">Base URL</label><input v-model="form.base_url" class="form-input" placeholder="https://..." /></div>
        <div class="form-group"><label class="form-label">Username</label><input v-model="form.username" class="form-input" /></div>
        <div class="form-group"><label class="form-label">Password</label><input v-model="form.password" type="password" class="form-input" /></div>
        <button class="btn btn-primary" @click="addSource">Save Source</button>
      </div>
    </div>

    <div class="grid grid-2">
      <div v-for="s in sources" :key="s.id" class="card source-card">
        <div class="source-header">
          <div>
            <span :class="['badge', s.type === 'webdav' ? 'badge-blue' : 'badge-green']">{{ s.type.toUpperCase() }}</span>
            <span :class="['badge', s.enabled ? 'badge-green' : 'badge-red']" style="margin-left:6px">{{ s.enabled ? "Active" : "Disabled" }}</span>
          </div>
          <button v-if="isAdmin" class="btn btn-danger btn-sm" @click="deleteSource(s.id)">Delete</button>
        </div>
        <div class="source-url">{{ s.base_url }}</div>
        <div class="source-meta">
          <span v-if="s.username">User: {{ s.username }}</span>
          <span v-if="s.lastSync !== 'Never'">Last Sync: {{ s.lastSync }}</span>
          <span v-else class="text-muted">Not synced</span>
        </div>
      </div>
      <div v-if="!sources.length" class="empty-state" style="grid-column:1/-1">
        <div class="empty-state-icon">☁️</div><div>No external storage sources configured.</div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.page { max-width: 1000px; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.page-title { font-size: 20px; font-weight: 700; }
.source-card { display: flex; flex-direction: column; gap: 10px; }
.source-header { display: flex; align-items: center; justify-content: space-between; }
.source-url { font-size: 13px; color: var(--accent); word-break: break-all; font-family: monospace; }
.source-meta { display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary); }
.text-muted { color: var(--text-muted); }
</style>
