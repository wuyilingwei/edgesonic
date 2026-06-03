<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAuth, parseXmlAttrs } from "../api";

const { isSuperAdmin, authFetch, authPost } = useAuth();
const permissions = ref<Array<{ level: number; name: string; enabled: boolean; maxRph: number }>>([]);
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") { toast.value = { show: true, msg, type }; setTimeout(() => { toast.value.show = false; }, 3000); }

const levelLabels: Record<number, string> = { 0: "Guest", 1: "User", 2: "Admin", 3: "Super Admin" };
const permLabels: Record<string, string> = {
  stream: "Stream", download: "Download", upload: "Upload", edit_tags: "Edit Tags",
  manage_sources: "Manage Sources", manage_users: "Manage Users",
  manage_permissions: "Manage Permissions", browse: "Browse", search: "Search",
};

async function load() {
  try {
    const xml = await authFetch("getPermissions");
    const items: typeof permissions.value = [];
    const re = /<permission\s+([^>]+)\/>/g;
    let m;
    while ((m = re.exec(xml))) {
      items.push({
        level: 0, name: m[1].match(/name="([^"]+)"/)?.[1] || "",
        enabled: (m[1].match(/enabled="([^"]+)"/)?.[1] || "0") === "1",
        maxRph: parseInt(m[1].match(/maxRph="(\d+)"/)?.[1] || "0"),
      });
    }
    if (items.length === 0) {
      // Fallback: parse grouped structure
      const groupedRe = /<permissions\s+level="(\d)">([\s\S]*?)<\/permissions>/g;
      let gm;
      while ((gm = re.exec(xml))) { /* handle grouped */ }
    }
    permissions.value = items;
  } catch { permissions.value = []; }
}

async function toggle(level: number, name: string, enabled: boolean) {
  try {
    await authPost("updatePermission", { level, permission: name, enabled: enabled ? 1 : 0 });
    load(); showToast(`${permLabels[name] || name}: ${enabled ? "ON" : "OFF"}`);
  } catch { showToast("Failed to update permission", "error"); }
}

async function setRph(level: number, name: string, rph: number) {
  try {
    await authPost("updatePermission", { level, permission: name, max_rph: rph });
    load(); showToast("Rate limit updated");
  } catch { showToast("Failed to update rate limit", "error"); }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1 class="page-title">Permissions</h1>
      <span class="badge badge-yellow">Super Admin Only</span>
    </div>

    <div v-if="!isSuperAdmin" class="card">
      <div class="empty-state"><div class="empty-state-icon">🔐</div><div>Only Super Admins can manage permissions.</div></div>
    </div>

    <div v-else class="perm-grid">
      <div v-for="level in [3, 2, 1, 0]" :key="level" class="card perm-card">
        <div class="card-header">
          <span class="card-title">{{ levelLabels[level] }}</span>
          <span :class="['badge', level === 3 ? 'badge-yellow' : level === 2 ? 'badge-blue' : level === 1 ? 'badge-green' : 'badge-red']">Level {{ level }}</span>
        </div>
        <div class="perm-list">
          <div v-for="(label, key) in permLabels" :key="key" class="perm-row">
            <span class="perm-name">{{ label }}</span>
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
              <span class="rph-label">req/h</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.page { max-width: 1100px; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.page-title { font-size: 20px; font-weight: 700; }
.perm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.perm-card { padding: 0; overflow: hidden; }
.perm-card .card-header { padding: 14px 16px; border-bottom: 1px solid var(--border); margin-bottom: 0; }
.perm-list { padding: 8px 0; }
.perm-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid rgba(48, 54, 61, 0.2); }
.perm-row:last-child { border-bottom: none; }
.perm-name { font-size: 13px; color: var(--text-primary); }
.perm-controls { display: flex; align-items: center; gap: 6px; }
.rph-input { width: 52px; padding: 2px 6px; font-size: 11px; text-align: center; }
.rph-label { font-size: 10px; color: var(--text-muted); width: 24px; }

/* Toggle Switch */
.toggle { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider { position: absolute; inset: 0; background: var(--bg-tertiary); border-radius: 20px; transition: 0.2s; border: 1px solid var(--border); }
.toggle-slider::before { content: ""; position: absolute; height: 14px; width: 14px; left: 2px; bottom: 2px; background: var(--text-secondary); border-radius: 50%; transition: 0.2s; }
.toggle input:checked + .toggle-slider { background: var(--accent); border-color: var(--accent); }
.toggle input:checked + .toggle-slider::before { transform: translateX(16px); background: #fff; }
</style>
