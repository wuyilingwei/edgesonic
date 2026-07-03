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
import { useAuth } from "../api";

const { t } = useI18n();
const { username: currentUsername, isAdmin, isSuperAdmin, edgesonicFetch, edgesonicPost, restUrl } = useAuth();
const users = ref<Array<{ username: string; level: number; enabled: boolean }>>([]);
const loading = ref(true);
const showForm = ref(false);
const form = ref({ username: "", password: "", level: 1 });
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const levelColors: Record<number, string> = { 0: "muted", 1: "success", 2: "info", 3: "warning" };

// 064 — Per-user cache-buster for avatar thumbs. Bump on successful upload so
// the existing /rest/getAvatar response (Cache-Control: max-age=86400 from
// subsonic/account.ts) doesn't stick around in the browser cache.
const avatarBust = ref<Record<string, number>>({});
function avatarSrc(u: string): string {
  const ts = avatarBust.value[u] ?? 0;
  return restUrl("getAvatar", { username: u, ...(ts ? { _ts: String(ts) } : {}) });
}
function onAvatarError(e: Event) {
  // getAvatar returns 404 when avatar_r2_key is null. Hide the broken img and
  // let the CSS .avatar-fallback show through (placed behind the img).
  const img = e.target as HTMLImageElement;
  img.style.visibility = "hidden";
}

// ----- Avatar modal state -----
const showAvatarModal = ref(false);
const avatarTarget = ref<{ username: string } | null>(null);
const avatarPreview = ref<string>(""); // data: URL preview of compressed JPEG
const avatarBase64 = ref<string>("");  // raw base64 (no data: prefix) — sent to setAvatar
const avatarMime = ref<string>("image/jpeg");
const avatarUploading = ref(false);

function openAvatarModal(u: { username: string }) {
  avatarTarget.value = { username: u.username };
  avatarPreview.value = "";
  avatarBase64.value = "";
  avatarMime.value = "image/jpeg";
  showAvatarModal.value = true;
}
function closeAvatarModal() {
  showAvatarModal.value = false;
  avatarTarget.value = null;
  avatarPreview.value = "";
  avatarBase64.value = "";
}

// Canvas compression: long edge ≤200px, iterative JPEG quality 0.85→0.4 until
// ≤100KB. Mirrors the cover compressor in TagEditor.vue (042). Output is
// always image/jpeg — simpler than threading PNG through the quality loop.
async function compressToJpeg(file: File): Promise<{ dataUrl: string; base64: string; mime: string }> {
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image decode failed"));
      i.src = blobUrl;
    });
    const longEdge = 200;
    const scale = Math.min(1, longEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    ctx.fillStyle = "#fff"; // flatten alpha so JPEG doesn't show black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const MAX_BYTES = 100 * 1024;
    let quality = 0.85;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    // dataUrl length → approx bytes: subtract header then *3/4
    const estimateBytes = (s: string) => Math.floor((s.length - s.indexOf(",") - 1) * 3 / 4);
    while (estimateBytes(dataUrl) > MAX_BYTES && quality > 0.4) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return { dataUrl, base64, mime: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function onAvatarFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  // Pre-validate against the worker's 500KB limit AFTER compression — but we
  // can warn early if the source is huge (e.g. 20MB raw camera shot would
  // still compress fine, so only block clearly non-image files).
  if (!/^image\//.test(file.type)) {
    showToast(t("users.avatar.invalidMime"), "error");
    input.value = "";
    return;
  }
  try {
    const { dataUrl, base64, mime } = await compressToJpeg(file);
    avatarPreview.value = dataUrl;
    avatarBase64.value = base64;
    avatarMime.value = mime;
  } catch {
    showToast(t("users.avatar.uploadFailed"), "error");
  }
  // Allow re-selecting the same file later
  input.value = "";
}

function clearAvatarSelection() {
  avatarPreview.value = "";
  avatarBase64.value = "";
}

async function submitAvatar() {
  if (!avatarTarget.value || !avatarBase64.value) return;
  avatarUploading.value = true;
  try {
    const raw = await edgesonicPost("users/setAvatar", {
      username: avatarTarget.value.username,
      imageBase64: avatarBase64.value,
      mimeType: avatarMime.value,
    });
    const resp = JSON.parse(raw) as { ok?: boolean; error?: string };
    if (!resp.ok) throw new Error(resp.error || "upload failed");
    // Bust cache so the row thumb refetches the new bytes.
    avatarBust.value = { ...avatarBust.value, [avatarTarget.value.username]: Date.now() };
    showToast(t("users.avatar.uploaded"));
    closeAvatarModal();
  } catch {
    showToast(t("users.avatar.uploadFailed"), "error");
  } finally {
    avatarUploading.value = false;
  }
}

// ----- CRUD — 072 ported off XML envelopes to plain JSON now that the whole
// /edgesonic/users bucket emits {ok,...}/{ok:false,error}. The wrapper
// edgesonicFetch/Post still returns a raw response string so we JSON.parse
// here (consistent with writeTags etc. elsewhere in api.ts). -----
interface OkJson { ok: boolean; error?: string }
interface UsersListJson extends OkJson { users?: Array<{ username: string; level: number; enabled: boolean }> }

function safeParse<T extends OkJson>(raw: string): T {
  try { return JSON.parse(raw) as T; } catch { return { ok: false, error: "bad_json" } as T; }
}

async function load() {
  loading.value = true;
  try {
    const raw = await edgesonicFetch("users/list");
    const resp = safeParse<UsersListJson>(raw);
    if (!resp.ok || !Array.isArray(resp.users)) { users.value = []; return; }
    users.value = resp.users.map((u) => ({
      username: u.username || "",
      level: typeof u.level === "number" ? u.level : parseInt(String(u.level ?? "1")),
      enabled: !!u.enabled,
    }));
  } catch { users.value = []; } finally {
    loading.value = false;
  }
}

async function addUser() {
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("users/create", form.value));
    if (!resp.ok) throw new Error(resp.error || "create failed");
    showForm.value = false; form.value = { username: "", password: "", level: 1 };
    load(); showToast(t("users.created"));
  } catch { showToast(t("users.createFailed"), "error"); }
}

async function updateUser(user: { username: string; level?: number; enabled?: number }) {
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("users/update", user));
    if (!resp.ok) throw new Error(resp.error || "update failed");
    load(); showToast(t("users.updated"));
  } catch { showToast(t("users.updateFailed"), "error"); }
}

async function deleteUser(username: string) {
  if (!confirm(t("users.deleteConfirm", { name: username }))) return;
  try {
    const resp = safeParse<OkJson>(await edgesonicPost("users/delete", { username }));
    if (!resp.ok) throw new Error(resp.error || "delete failed");
    load(); showToast(t("users.deleted"));
  } catch { showToast(t("users.deleteFailed"), "error"); }
}

function toggleEnabled(u: { username: string; enabled: boolean }) {
  updateUser({ username: u.username, enabled: u.enabled ? 0 : 1 });
}

function changeLevel(u: { username: string; level: number }, newLevel: number) {
  updateUser({ username: u.username, level: newLevel });
}

// 064 — Avatar button is visible when caller can edit this row's avatar:
// always for self; admin+ for everyone.
const canEditAvatar = (u: { username: string }) =>
  u.username === currentUsername.value || isAdmin.value;

const canSubmitAvatar = computed(() => !!avatarBase64.value && !avatarUploading.value);

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("users.label") }}</div>
        <h1 class="page-title">{{ t("users.title") }}</h1>
      </div>
      <button v-if="isAdmin" :class="showForm ? 'btn-secondary' : 'btn-primary'" @click="showForm = !showForm">{{ showForm ? t("common.cancel") : t("users.add") }}</button>
    </div>

    <div v-if="showForm" class="card" style="margin-bottom:1.25rem; max-width:450px">
      <div class="card-header"><span class="card-title">{{ t("users.newUser") }}</span></div>
      <div style="display:flex; flex-direction:column; gap:0.8rem">
        <div class="form-group"><label class="form-label">{{ t("users.username") }}</label><input v-model="form.username" class="form-input" /></div>
        <div class="form-group"><label class="form-label">{{ t("users.password") }}</label><input v-model="form.password" type="password" class="form-input" /></div>
        <div class="form-group">
          <label class="form-label">{{ t("users.level") }}</label>
          <select v-model="form.level" class="form-select">
            <option v-if="isSuperAdmin" :value="3">3 — {{ t("users.levels.super") }}</option>
            <option :value="2">2 — {{ t("users.levels.admin") }}</option>
            <option :value="1">1 — {{ t("users.levels.user") }}</option>
            <option :value="0">0 — {{ t("users.levels.guest") }}</option>
          </select>
        </div>
        <button class="btn-primary" @click="addUser">{{ t("users.create") }}</button>
      </div>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>

    <!-- 064 — added a leading Avatar column; total cols now: avatar / name / level / status / actions -->
    <div v-else class="table-wrap" style="--grid-cols: 56px 1.5fr 1fr 1fr auto">
      <div class="table-header">
        <span></span>
        <span>{{ t("users.colUsername") }}</span><span>{{ t("users.colLevel") }}</span><span>{{ t("users.colStatus") }}</span><span>{{ t("users.colActions") }}</span>
      </div>
      <div v-for="u in users" :key="u.username" class="table-row">
        <span class="avatar-cell">
          <span class="avatar-fallback">{{ u.username.slice(0, 1).toUpperCase() }}</span>
          <img :src="avatarSrc(u.username)" :alt="u.username" class="avatar-img" @error="onAvatarError" />
        </span>
        <span class="user-name">{{ u.username }}</span>
        <span>
          <select v-if="isSuperAdmin" :value="u.level" @change="changeLevel(u, parseInt(($event.target as HTMLSelectElement).value))" class="form-select level-select">
            <option :value="3">{{ t("users.levels.super") }}</option><option :value="2">{{ t("users.levels.admin") }}</option><option :value="1">{{ t("users.levels.user") }}</option><option :value="0">{{ t("users.levels.guest") }}</option>
          </select>
          <span v-else :class="['status-badge', levelColors[u.level] || 'info']">{{ levelKeys[u.level] ? t(`users.levels.${levelKeys[u.level]}`) : u.level }}</span>
        </span>
        <span>
          <span :class="['status-badge', u.enabled ? 'success' : 'error']" style="cursor:pointer" @click="toggleEnabled(u)">{{ u.enabled ? t("users.active") : t("users.disabled") }}</span>
        </span>
        <span class="row-actions">
          <button v-if="canEditAvatar(u)" class="btn-secondary btn-sm" :title="t('users.avatar.open')" @click="openAvatarModal(u)">{{ t("users.avatar.title") }}</button>
          <button v-if="isAdmin" class="btn-danger btn-sm" @click="deleteUser(u.username)">{{ t("common.delete") }}</button>
        </span>
      </div>
      <div v-if="!users.length" class="empty-state">{{ t("users.noUsers") }}</div>
    </div>

    <!-- 064 — Avatar modal: preview + file picker + submit -->
    <div v-if="showAvatarModal" class="modal-backdrop" @click.self="closeAvatarModal">
      <div class="card avatar-modal">
        <div class="card-header">
          <span class="card-title">{{ t("users.avatar.title") }} — {{ avatarTarget?.username }}</span>
          <button class="btn-icon" :aria-label="t('common.close')" @click="closeAvatarModal">×</button>
        </div>
        <div class="avatar-modal-body">
          <div class="avatar-preview-wrap">
            <div class="mono-label">{{ t("users.avatar.current") }}</div>
            <div class="avatar-preview-current">
              <span class="avatar-fallback avatar-fallback-lg">{{ avatarTarget?.username.slice(0, 1).toUpperCase() }}</span>
              <img v-if="avatarTarget" :src="avatarSrc(avatarTarget.username)" :alt="avatarTarget.username" class="avatar-img-lg" @error="onAvatarError" />
            </div>
          </div>
          <div class="avatar-preview-wrap" v-if="avatarPreview">
            <div class="mono-label">{{ t("users.avatar.change") }}</div>
            <img :src="avatarPreview" class="avatar-img-lg" alt="preview" />
          </div>
        </div>
        <div class="avatar-modal-actions">
          <label class="btn-secondary file-label">
            <input type="file" accept="image/jpeg,image/png,image/*" style="display:none" @change="onAvatarFileChange" />
            {{ t("users.avatar.upload") }}
          </label>
          <button v-if="avatarPreview" class="btn-secondary" @click="clearAvatarSelection">{{ t("users.avatar.clear") }}</button>
          <button class="btn-primary" :disabled="!canSubmitAvatar" @click="submitAvatar">
            {{ avatarUploading ? t("common.loading") : t("users.avatar.change") }}
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
.page { max-width: 900px; }
.user-name { font-family: var(--font-mono); font-weight: 600; font-size: var(--fs-sm); color: var(--color-text-primary); letter-spacing: 0.05em; }
.level-select { display: inline-block; width: auto; padding: 0.25rem 0.5rem; font-size: var(--fs-sm); }

/* 064 — Avatar cell + row actions */
.avatar-cell {
  position: relative;
  width: 36px;
  height: 36px;
  display: inline-block;
}
.avatar-img {
  position: absolute;
  inset: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--color-border, rgba(0,0,0,0.1));
  background: var(--color-surface, #fff);
}
.avatar-fallback {
  position: absolute;
  inset: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-surface-2, #ececec);
  color: var(--color-text-muted, #888);
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: var(--fs-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.row-actions {
  display: inline-flex;
  gap: 0.4rem;
  justify-content: flex-end;
}

/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.avatar-modal {
  position: relative;
  width: min(520px, 92vw);
  padding: 1.25rem;
}
.avatar-modal-body {
  display: flex;
  gap: 1.25rem;
  margin: 0.75rem 0 1rem;
  flex-wrap: wrap;
}
.avatar-preview-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.avatar-preview-current {
  position: relative;
  width: 120px;
  height: 120px;
}
.avatar-img-lg {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  object-fit: cover;
  border: 1px solid var(--color-border, rgba(0,0,0,0.1));
  background: var(--color-surface, #fff);
  position: relative;
}
.avatar-preview-current .avatar-img-lg {
  position: absolute;
  inset: 0;
}
.avatar-fallback-lg {
  position: absolute;
  inset: 0;
  width: 120px;
  height: 120px;
  border-radius: 8px;
  font-size: 3rem;
  background: var(--color-surface-2, #ececec);
  color: var(--color-text-muted, #888);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
}
.avatar-modal-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.file-label { cursor: pointer; }
.btn-icon {
  background: transparent;
  border: none;
  font-size: 1.2rem;
  cursor: pointer;
  padding: 0 0.4rem;
  color: var(--color-text-muted, #888);
}
.btn-icon:hover { color: var(--color-text-primary, #111); }
</style>
