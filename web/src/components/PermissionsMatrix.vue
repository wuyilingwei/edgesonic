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
import { useAuth } from "../api";

const { t } = useI18n();
const { isSuperAdmin, edgesonicFetch, edgesonicPost } = useAuth();
const permissions = ref<Array<{ level: number; name: string; enabled: boolean; maxRph: number }>>([]);
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const permKeys = ["stream", "download", "upload", "edit_tags", "manage_sources", "manage_users", "manage_permissions", "browse", "search"];

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
        maxRph: parseInt(m[1].match(/maxRph="(\d+)"/)?.[1] || "0"),
      });
    }
    permissions.value = items;
  } catch { permissions.value = []; }
}

async function toggle(level: number, name: string, enabled: boolean) {
  try {
    await edgesonicPost("permissions/update", { level, permission: name, enabled: enabled ? 1 : 0 });
    load();
    showToast(t("settings.permissions.updated", { name: t(`settings.permissions.perms.${name}`), state: enabled ? t("common.on") : t("common.off") }));
  } catch { showToast(t("settings.permissions.updateFailed"), "error"); }
}

async function setRph(level: number, name: string, rph: number) {
  try {
    await edgesonicPost("permissions/update", { level, permission: name, max_rph: rph });
    load(); showToast(t("settings.permissions.rateUpdated"));
  } catch { showToast(t("settings.permissions.rateFailed"), "error"); }
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="!isSuperAdmin" class="empty-state">
      <div class="empty-state-icon">⛔</div>
      <div>{{ t("settings.permissions.denied") }}</div>
    </div>

    <div v-else class="perm-grid">
      <div v-for="level in [3, 2, 1, 0]" :key="level" class="card perm-card">
        <div class="card-header">
          <span class="card-title">{{ t(`settings.permissions.levels.${levelKeys[level]}`) }}</span>
          <span :class="['status-badge', level === 3 ? 'warning' : level === 2 ? 'info' : level === 1 ? 'success' : 'muted']">{{ t("settings.permissions.level", { n: level }) }}</span>
        </div>
        <div class="perm-list">
          <div v-for="key in permKeys" :key="key" class="perm-row">
            <span class="perm-name">{{ t(`settings.permissions.perms.${key}`) }}</span>
            <div class="perm-controls">
              <label class="toggle">
                <input type="checkbox" :checked="permissions.find(p => p.level === level && p.name === key)?.enabled" @change="toggle(level, key, ($event.target as HTMLInputElement).checked)" />
                <span class="toggle-slider"></span>
              </label>
              <input
                type="number"
                class="form-input rph-input"
                :value="permissions.find(p => p.level === level && p.name === key)?.maxRph || 0"
                @change="setRph(level, key, parseInt(($event.target as HTMLInputElement).value) || 0)"
                placeholder="RPH"
                min="0"
              />
              <span class="rph-label">{{ t("settings.permissions.rph") }}</span>
            </div>
          </div>
        </div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
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
.perm-controls { display: flex; align-items: center; gap: 0.4rem; }
.rph-input { width: 56px; padding: 0.15rem 0.35rem; font-size: var(--fs-xs); text-align: center; }
.rph-label { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); width: 30px; }
</style>
