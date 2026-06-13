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
// 062 — Internet Radio management UI. Thin shell over 045 backend:
//   GET    /rest/getInternetRadioStations         (any authed user)
//   GET/POST /rest/createInternetRadioStation     (manage_radio)
//   GET/POST /rest/updateInternetRadioStation     (manage_radio)
//   GET/POST /rest/deleteInternetRadioStation     (manage_radio)
// All four are reached through authFetch with query params — backend supports
// both GET and POST (form-encoded). GET keeps the call sites readable and
// avoids having to switch to multipart for the optional homepageUrl field.
import { ref, onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";

const { t } = useI18n();
const { authFetch, level } = useAuth();

interface Station {
  id: string;
  name: string;
  streamUrl: string;
  homepageUrl: string;
}

// Only admins (level >= 2) can CUD. We still show the list to everyone — the
// sidebar entry is open at minLevel 0 to mirror /library.
const canManage = computed(() => level.value >= 2);

const stations = ref<Station[]>([]);
const loading = ref(false);
const showForm = ref(false);
const form = ref({ name: "", streamUrl: "", homepageUrl: "" });

const editing = ref<Station | null>(null);
const editForm = ref({ name: "", streamUrl: "", homepageUrl: "" });

const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type: "success" | "error" = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

// Subsonic responses signal failure via <subsonic-response status="failed">.
// Our success path emits status="ok" — checking the substring is enough because
// the worker always serialises that single attribute on the root element.
function failed(xml: string): boolean {
  return /status="failed"/.test(xml);
}

function extractError(xml: string): string | null {
  const m = /<error[^>]+message="([^"]+)"/.exec(xml);
  return m ? m[1] : null;
}

async function load() {
  loading.value = true;
  try {
    const xml = await authFetch("getInternetRadioStations");
    const rows = parseXmlAttrs(xml, "internetRadioStation");
    stations.value = rows.map((r) => ({
      id: r.id || "",
      name: r.name || "",
      streamUrl: r.streamUrl || "",
      homepageUrl: r.homepageUrl || "",
    }));
  } catch {
    stations.value = [];
  } finally {
    loading.value = false;
  }
}

function resetAddForm() {
  form.value = { name: "", streamUrl: "", homepageUrl: "" };
}

async function addStation() {
  const name = form.value.name.trim();
  const streamUrl = form.value.streamUrl.trim();
  const homepageUrl = form.value.homepageUrl.trim();
  if (!name || !streamUrl) {
    showToast(t("radio.requiredMissing"), "error");
    return;
  }
  const params: Record<string, string> = { name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  try {
    const xml = await authFetch("createInternetRadioStation", params);
    if (failed(xml)) throw new Error(extractError(xml) || "create failed");
    showToast(t("radio.added"));
    showForm.value = false;
    resetAddForm();
    await load();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("radio.addFailed")}: ${msg}`, "error");
  }
}

function openEdit(s: Station) {
  editing.value = s;
  editForm.value = { name: s.name, streamUrl: s.streamUrl, homepageUrl: s.homepageUrl };
}
function closeEdit() { editing.value = null; }

async function saveEdit() {
  if (!editing.value) return;
  const orig = editing.value;
  const params: Record<string, string> = { id: orig.id };
  // Only ship fields that actually changed — backend treats undefined as
  // "leave alone" and empty string for homepageUrl as "clear column".
  if (editForm.value.name !== orig.name) {
    if (!editForm.value.name.trim()) {
      showToast(t("radio.requiredMissing"), "error");
      return;
    }
    params.name = editForm.value.name.trim();
  }
  if (editForm.value.streamUrl !== orig.streamUrl) {
    if (!editForm.value.streamUrl.trim()) {
      showToast(t("radio.requiredMissing"), "error");
      return;
    }
    params.streamUrl = editForm.value.streamUrl.trim();
  }
  if (editForm.value.homepageUrl !== orig.homepageUrl) {
    params.homepageUrl = editForm.value.homepageUrl.trim();
  }
  if (Object.keys(params).length === 1) {
    closeEdit();
    return;
  }
  try {
    const xml = await authFetch("updateInternetRadioStation", params);
    if (failed(xml)) throw new Error(extractError(xml) || "update failed");
    showToast(t("radio.updated"));
    closeEdit();
    await load();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("radio.updateFailed")}: ${msg}`, "error");
  }
}

async function deleteStation(s: Station) {
  if (!confirm(t("radio.confirmDelete", { name: s.name }))) return;
  try {
    const xml = await authFetch("deleteInternetRadioStation", { id: s.id });
    if (failed(xml)) throw new Error(extractError(xml) || "delete failed");
    showToast(t("radio.deleted"));
    await load();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("radio.deleteFailed")}: ${msg}`, "error");
  }
}

async function copyStreamUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    showToast(t("radio.copied"));
  } catch {
    showToast(t("radio.copyFailed"), "error");
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("radio.label") }}</div>
        <h1 class="page-title">{{ t("radio.title") }}</h1>
      </div>
      <button
        v-if="canManage"
        :class="showForm ? 'btn-secondary' : 'btn-primary'"
        @click="showForm = !showForm"
      >
        {{ showForm ? t("common.cancel") : t("radio.add") }}
      </button>
    </div>

    <div v-if="canManage && showForm" class="card" style="margin-bottom:1.25rem; max-width:520px">
      <div class="card-header"><span class="card-title">{{ t("radio.newStation") }}</span></div>
      <div style="display:flex; flex-direction:column; gap:0.8rem">
        <div class="form-group">
          <label class="form-label">{{ t("radio.name") }}</label>
          <input v-model="form.name" class="form-input" :placeholder="t('radio.namePlaceholder')" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("radio.streamUrl") }}</label>
          <input v-model="form.streamUrl" class="form-input" placeholder="https://stream.example.com/live.mp3" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("radio.homepageUrl") }} <span class="optional">({{ t("radio.optional") }})</span></label>
          <input v-model="form.homepageUrl" class="form-input" placeholder="https://example.com" />
        </div>
        <button class="btn-primary" @click="addStation">{{ t("radio.save") }}</button>
      </div>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <div v-if="loading && !stations.length" class="empty-state">
      <div class="empty-state-icon">◌</div><div>{{ t("common.loading") }}</div>
    </div>

    <div v-else class="grid grid-2">
      <div v-for="s in stations" :key="s.id" class="card hoverable radio-card">
        <div class="radio-header">
          <span class="status-badge info">RADIO</span>
          <div class="radio-actions" v-if="canManage">
            <button class="btn-secondary btn-sm" @click="openEdit(s)">{{ t("common.edit") }}</button>
            <button class="btn-danger btn-sm" @click="deleteStation(s)">{{ t("common.delete") }}</button>
          </div>
        </div>
        <div class="radio-name">{{ s.name }}</div>
        <div class="radio-meta">
          <div class="radio-row">
            <span class="meta-label">{{ t("radio.streamUrl") }}:</span>
            <span class="meta-value mono">{{ s.streamUrl }}</span>
            <button class="link-button" @click="copyStreamUrl(s.streamUrl)">{{ t("common.copy") }}</button>
          </div>
          <div v-if="s.homepageUrl" class="radio-row">
            <span class="meta-label">{{ t("radio.homepageUrl") }}:</span>
            <a :href="s.homepageUrl" target="_blank" rel="noopener noreferrer" class="meta-link">{{ s.homepageUrl }}</a>
          </div>
        </div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
      <div v-if="!stations.length && !loading" class="empty-state" style="grid-column:1/-1">
        <div class="empty-state-icon">◌</div><div>{{ t("radio.empty") }}</div>
      </div>
    </div>

    <!-- Edit modal -->
    <div v-if="editing" class="modal-backdrop" @click.self="closeEdit">
      <div class="modal">
        <div class="modal-title">{{ t("radio.editStation") }}</div>
        <div style="display:flex; flex-direction:column; gap:0.8rem">
          <div class="form-group">
            <label class="form-label">{{ t("radio.name") }}</label>
            <input v-model="editForm.name" class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("radio.streamUrl") }}</label>
            <input v-model="editForm.streamUrl" class="form-input" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("radio.homepageUrl") }} <span class="optional">({{ t("radio.optional") }})</span></label>
            <input v-model="editForm.homepageUrl" class="form-input" :placeholder="t('radio.homepageClearHint')" />
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeEdit">{{ t("common.cancel") }}</button>
          <button class="btn-primary" @click="saveEdit">{{ t("radio.save") }}</button>
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
.radio-card { display: flex; flex-direction: column; gap: 0.55rem; }
.radio-header { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; }
.radio-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: flex-end; }
.radio-name {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: 0.01em;
}
.radio-meta {
  display: flex; flex-direction: column; gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
}
.radio-row {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
}
.meta-label {
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.meta-value {
  color: var(--color-text-primary);
  word-break: break-all;
}
.meta-value.mono { font-family: var(--font-mono); }
.meta-link {
  color: var(--color-accent-primary);
  word-break: break-all;
  text-decoration: underline dotted;
}
.meta-link:hover { color: var(--color-text-primary); }
.optional {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.05em;
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
</style>
