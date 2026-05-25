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
import { useAuth } from "../api";

const { isAdmin, authFetch } = useAuth();
const sources = ref<Array<{ id: string; type: string; base_url: string; enabled: boolean }>>([]);
const showForm = ref(false);
const form = ref({ type: "webdav", base_url: "", username: "", password: "" });

async function load() {
  const xml = await authFetch("getStorageSources");
  // parse sources from XML
  const items: typeof sources.value = [];
  const re = /<source\s+([^>]+)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = m[1].match(/id="([^"]+)"/)?.[1] || "";
    const type = m[1].match(/type="([^"]+)"/)?.[1] || "";
    const base = m[1].match(/baseUrl="([^"]+)"/)?.[1] || "";
    items.push({ id, type, base_url: base, enabled: true });
  }
  sources.value = items;
}

async function addSource() {
  await authFetch("addStorageSource", form.value);
  showForm.value = false;
  load();
}

onMounted(load);
</script>

<template>
  <div>
    <h1 style="margin-bottom:16px">Storage Sources</h1>
    <button v-if="isAdmin" @click="showForm = !showForm" class="btn">{{ showForm ? "Cancel" : "Add Source" }}</button>

    <div v-if="showForm" class="form-panel">
      <select v-model="form.type">
        <option value="webdav">WebDAV</option>
        <option value="subsonic">Subsonic</option>
      </select>
      <input v-model="form.base_url" placeholder="Base URL (https://...)" />
      <input v-model="form.username" placeholder="Username" />
      <input v-model="form.password" type="password" placeholder="Password" />
      <button @click="addSource" class="btn primary">Save</button>
    </div>

    <div class="list">
      <div v-for="s in sources" :key="s.id" class="card">
        <div class="card-title">{{ s.id }}</div>
        <div class="card-meta">{{ s.type }} — {{ s.base_url }}</div>
      </div>
      <p v-if="sources.length === 0" class="empty">No external sources configured.</p>
    </div>
  </div>
</template>

<style scoped>
.btn { padding: 8px 16px; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; font-size: 13px; margin-bottom: 16px; }
.btn:hover { background: #30363d; }
.btn.primary { background: #238636; border-color: #238636; }
.form-panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 10px; max-width: 400px; }
.form-panel input, .form-panel select { padding: 8px 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 13px; }
.list { display: flex; flex-direction: column; gap: 8px; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 16px; }
.card-title { font-weight: 600; font-size: 14px; }
.card-meta { font-size: 12px; color: #8b949e; margin-top: 4px; }
.empty { color: #8b949e; font-size: 13px; margin-top: 16px; }
</style>
