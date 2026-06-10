<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";

const { t } = useI18n();
const { isAdmin, isSuperAdmin, authFetch, authPost } = useAuth();
const users = ref<Array<{ username: string; level: number; enabled: boolean }>>([]);
const showForm = ref(false);
const form = ref({ username: "", password: "", level: 1 });
const editingUser = ref("");
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const levelColors: Record<number, string> = { 0: "muted", 1: "success", 2: "info", 3: "warning" };

async function load() {
  try {
    const xml = await authFetch("getUsers");
    users.value = parseXmlAttrs(xml, "user").map((u) => ({
      username: u.username || "", level: parseInt(u.level || "1"),
      enabled: u.enabled === "1" || u.enabled === "true",
    }));
  } catch { users.value = []; }
}

async function addUser() {
  try { await authPost("createUser", form.value); showForm.value = false; form.value = { username: "", password: "", level: 1 }; load(); showToast(t("users.created")); }
  catch { showToast(t("users.createFailed"), "error"); }
}

async function updateUser(user: { username: string; level?: number; enabled?: number }) {
  try { await authPost("updateUser", user); load(); showToast(t("users.updated")); }
  catch { showToast(t("users.updateFailed"), "error"); }
}

async function deleteUser(username: string) {
  if (!confirm(t("users.deleteConfirm", { name: username }))) return;
  try { await authPost("deleteUser", { username }); load(); showToast(t("users.deleted")); }
  catch { showToast(t("users.deleteFailed"), "error"); }
}

function toggleEnabled(u: { username: string; enabled: boolean }) {
  updateUser({ username: u.username, enabled: u.enabled ? 0 : 1 });
}

function changeLevel(u: { username: string; level: number }, newLevel: number) {
  updateUser({ username: u.username, level: newLevel });
}

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

    <div class="table-wrap" style="--grid-cols: 1.5fr 1fr 1fr auto">
      <div class="table-header">
        <span>{{ t("users.colUsername") }}</span><span>{{ t("users.colLevel") }}</span><span>{{ t("users.colStatus") }}</span><span>{{ t("users.colActions") }}</span>
      </div>
      <div v-for="u in users" :key="u.username" class="table-row">
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
        <span>
          <button v-if="isAdmin" class="btn-danger btn-sm" @click="deleteUser(u.username)">{{ t("common.delete") }}</button>
        </span>
      </div>
      <div v-if="!users.length" class="empty-state">{{ t("users.noUsers") }}</div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.page { max-width: 900px; }
.user-name { font-family: var(--font-mono); font-weight: 600; font-size: var(--fs-sm); color: var(--color-text-primary); letter-spacing: 0.05em; }
.level-select { display: inline-block; width: auto; padding: 0.25rem 0.5rem; font-size: var(--fs-sm); }
</style>
