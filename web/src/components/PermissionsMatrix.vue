
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";

const { t } = useI18n();
const { isSuperAdmin, edgesonicFetch, edgesonicPost } = useAuth();
const permissions = ref<Array<{ level: number; name: string; enabled: boolean }>>([]);
const dirty = ref(false);
const saving = ref(false);
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const permKeys = ["browse", "search", "stream", "download", "upload", "delete", "edit_tags", "manage_files", "manage_sources", "manage_users", "maintenance_cleanup", "manage_settings"];

async function load() {
  try {
    const xml = await edgesonicFetch("permissions/list");
    const items: typeof permissions.value = [];
    const re = /<permission\s+([^>]+)\/>/g;
    let m;
    while ((m = re.exec(xml))) {
      items.push({
        level: parseInt(m[1].match(/level="(\d)"/)?.[1] || "0"),
        name: m[1].match(/name="([^"]+)"/)?.[1] || "",
        enabled: (m[1].match(/enabled="([^"]+)"/)?.[1] || "0") === "1",
      });
    }
    permissions.value = items;
    dirty.value = false;
  } catch { permissions.value = []; }
}

function setPerm(level: number, name: string, checked: boolean) {
  const row = permissions.value.find((p) => p.level === level && p.name === name);
  if (row) row.enabled = checked;
  else permissions.value.push({ level, name, enabled: checked });
}
function toggle(level: number, name: string, checked: boolean) {
  setPerm(level, name, checked);
  if (checked) {
    for (let higher = level + 1; higher <= 3; higher++) setPerm(higher, name, true);
  }
  dirty.value = true;
}

async function save() {
  if (!dirty.value || saving.value) return;
  saving.value = true;
  try {
    const text = await edgesonicPost("permissions/save", { permissions: permissions.value });
    const res = JSON.parse(text) as { ok: boolean; error?: string; envPushed?: boolean; envError?: string };
    if (!res.ok) throw new Error(res.error || "save failed");
    dirty.value = false;
    showToast(res.envPushed
      ? t("settings.permissions.savedEnv")
      : t("settings.permissions.saved"));
  } catch (e) {
    showToast(`${t("settings.permissions.saveFailed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
  saving.value = false;
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="!isSuperAdmin" class="empty-state">
      <div class="empty-state-icon">⛔</div>
      <div>{{ t("settings.permissions.denied") }}</div>
    </div>

    <template v-else>
      <div class="perm-toolbar">
        <span v-if="dirty" class="perm-dirty-hint">{{ t("settings.permissions.unsaved") }}</span>
        <button class="btn-primary btn-sm" :disabled="!dirty || saving" @click="save">
          {{ saving ? t("settings.permissions.saving") : t("common.save") }}
        </button>
      </div>

      <div class="perm-grid">
        <div v-for="level in [3, 2, 1, 0]" :key="level" class="card perm-card">
          <div class="card-header">
            <span class="card-title">{{ t(`settings.permissions.levels.${levelKeys[level]}`) }}</span>
            <span :class="['status-badge', level === 3 ? 'warning' : level === 2 ? 'info' : level === 1 ? 'success' : 'muted']">{{ t("settings.permissions.level", { n: level }) }}</span>
          </div>
          <div class="perm-list">
            <div v-for="key in permKeys" :key="key" class="perm-row">
              <span class="perm-name">{{ t(`settings.permissions.perms.${key}`) }}</span>
              <label class="toggle">
                <input
                  type="checkbox"
                  :checked="permissions.find(p => p.level === level && p.name === key)?.enabled"
                  @change="toggle(level, key, ($event.target as HTMLInputElement).checked)"
                />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
          <div class="corner corner-tr"></div>
          <div class="corner corner-bl"></div>
        </div>
      </div>
    </template>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.perm-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 0.7rem; margin-bottom: 0.8rem; }
.perm-dirty-hint { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-accent-primary); }
.perm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
.perm-card { padding: 0; overflow: hidden; }
.perm-card .card-header {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
  margin-bottom: 0;
}
.perm-list { padding: 0.4rem 0; }
.perm-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
}
.perm-row:last-child { border-bottom: none; }
.perm-name { font-size: var(--fs-sm); color: var(--color-text-primary); }
</style>
