<script setup lang="ts">
import { computed } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuth } from "./api";

const router = useRouter();
const route = useRoute();
const { isLoggedIn, username, level, isSuperAdmin, logout } = useAuth();

const levelLabels: Record<number, string> = { 0: "Guest", 1: "User", 2: "Admin", 3: "Super Admin" };

const navItems = computed(() => {
  const items: Array<{ label: string; path: string; icon: string; minLevel: number }> = [
    { label: "Dashboard", path: "/", icon: "◉", minLevel: 0 },
    { label: "Files", path: "/files", icon: "♫", minLevel: 0 },
    { label: "Transcoder", path: "/transcoder", icon: "⇄", minLevel: 0 },
    { label: "Sources", path: "/sources", icon: "☁", minLevel: 2 },
    { label: "Users", path: "/users", icon: "👥", minLevel: 2 },
    { label: "Permissions", path: "/permissions", icon: "🔐", minLevel: 3 },
  ];
  return items.filter((i) => level.value >= i.minLevel);
});

function navigate(path: string) {
  router.push(path);
}

function doLogout() {
  logout();
  router.push("/login");
}
</script>

<template>
  <div class="app">
    <!-- Sidebar -->
    <aside v-if="route.path !== '/login'" class="sidebar">
      <div class="sidebar-header">
        <div class="logo">
          <span class="logo-icon">♪</span>
          <span class="logo-text">EdgeSonic</span>
        </div>
      </div>

      <nav class="nav">
        <div v-for="item in navItems" :key="item.path"
          :class="['nav-item', { active: route.path === item.path }]"
          @click="navigate(item.path)">
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="user-info">
          <div class="avatar">{{ username?.charAt(0)?.toUpperCase() || "?" }}</div>
          <div class="user-detail">
            <div class="user-name">{{ username || "Guest" }}</div>
            <div class="user-level">{{ levelLabels[level] || "Unknown" }}</div>
          </div>
        </div>
        <button v-if="isLoggedIn" class="logout-btn" title="Logout" @click="doLogout">⏻</button>
      </div>
    </aside>

    <!-- Main Content -->
    <main :class="{ 'full-width': route.path === '/login' }">
      <div v-if="route.path !== '/login'" class="topbar">
        <div class="breadcrumb">
          <span class="bc-item">{{ route.meta?.title || route.path?.substring(1) || "Dashboard" }}</span>
        </div>
      </div>
      <div class="content">
        <router-view />
      </div>
    </main>
  </div>
</template>

<style>
/* === Reset & Base === */
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --border: #30363d;
  --text-primary: #e6edf3;
  --text-secondary: #8b949e;
  --text-muted: #6e7681;
  --accent: #58a6ff;
  --accent-bg: rgba(88, 166, 255, 0.1);
  --success: #3fb950;
  --danger: #f85149;
  --warning: #d29922;
  --radius: 8px;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", Roboto, sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* === Layout === */
.app { display: flex; min-height: 100vh; }

/* === Sidebar === */
.sidebar {
  width: 240px; min-width: 240px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  position: sticky; top: 0; height: 100vh;
}
.sidebar-header {
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--border);
}
.logo { display: flex; align-items: center; gap: 10px; }
.logo-icon { font-size: 22px; color: var(--accent); }
.logo-text { font-size: 18px; font-weight: 700; color: var(--text-primary); letter-spacing: -0.5px; }

.nav { flex: 1; padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; border-radius: 6px;
  cursor: pointer; color: var(--text-secondary);
  transition: all 0.15s; font-size: 14px; font-weight: 500;
  user-select: none;
}
.nav-item:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.nav-item.active {
  background: var(--accent-bg); color: var(--accent);
  box-shadow: inset 3px 0 0 var(--accent);
}
.nav-icon { font-size: 16px; width: 20px; text-align: center; }
.nav-label { flex: 1; }

.sidebar-footer {
  padding: 12px 16px; border-top: 1px solid var(--border);
  display: flex; align-items: center; gap: 10px;
}
.user-info { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.avatar {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 14px; flex-shrink: 0;
}
.user-detail { min-width: 0; }
.user-name { font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.user-level { font-size: 11px; color: var(--text-muted); }
.logout-btn {
  background: none; border: 1px solid var(--border); color: var(--text-secondary);
  width: 32px; height: 32px; border-radius: 6px; cursor: pointer;
  font-size: 14px; display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.logout-btn:hover { background: var(--bg-tertiary); color: var(--danger); border-color: var(--danger); }

/* === Main Area === */
main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
main.full-width { width: 100%; }
.topbar {
  height: 52px; padding: 0 28px;
  display: flex; align-items: center;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  position: sticky; top: 0; z-index: 10;
}
.breadcrumb { display: flex; align-items: center; gap: 6px; }
.bc-item { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.content { flex: 1; padding: 24px 28px; overflow-y: auto; }

/* === Shared Components === */
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
}
.card-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px;
}
.card-title { font-size: 16px; font-weight: 600; color: var(--text-primary); }

.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 6px;
  font-size: 13px; font-weight: 500; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg-tertiary);
  color: var(--text-primary); transition: all 0.15s;
}
.btn:hover { background: #30363d; }
.btn-primary { background: #238636; border-color: #238636; color: #fff; }
.btn-primary:hover { background: #2ea043; }
.btn-danger { background: transparent; border-color: var(--danger); color: var(--danger); }
.btn-danger:hover { background: rgba(248, 81, 73, 0.1); }
.btn-sm { padding: 4px 10px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.form-input, .form-select {
  padding: 8px 12px; background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: 6px;
  color: var(--text-primary); font-size: 13px; outline: none;
  transition: border-color 0.15s; width: 100%;
}
.form-input:focus, .form-select:focus { border-color: var(--accent); }
.form-input::placeholder { color: var(--text-muted); }
.form-select { cursor: pointer; }

.form-group { display: flex; flex-direction: column; gap: 6px; }
.form-label { font-size: 12px; font-weight: 500; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
.form-row { display: flex; gap: 12px; align-items: flex-end; }

.badge {
  display: inline-flex; align-items: center;
  padding: 2px 8px; border-radius: 12px;
  font-size: 11px; font-weight: 600;
}
.badge-blue { background: var(--accent-bg); color: var(--accent); }
.badge-green { background: rgba(63, 185, 80, 0.15); color: var(--success); }
.badge-red { background: rgba(248, 81, 73, 0.15); color: var(--danger); }
.badge-yellow { background: rgba(210, 153, 34, 0.15); color: var(--warning); }

.empty-state {
  text-align: center; padding: 40px 20px;
  color: var(--text-muted); font-size: 13px;
}
.empty-state-icon { font-size: 36px; margin-bottom: 12px; }

.table { width: 100%; border-collapse: collapse; }
.table th, .table td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.table th { font-weight: 600; color: var(--text-secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
.table tr:hover td { background: var(--bg-tertiary); }

.grid { display: grid; gap: 16px; }
.grid-2 { grid-template-columns: repeat(2, 1fr); }
.grid-3 { grid-template-columns: repeat(3, 1fr); }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 1200px) { .grid-4 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 768px) { .grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; } }

.toast {
  position: fixed; bottom: 24px; right: 24px; z-index: 100;
  padding: 12px 20px; border-radius: 8px; font-size: 13px;
  animation: slideIn 0.3s ease;
}
.toast-success { background: #238636; color: #fff; }
.toast-error { background: var(--danger); color: #fff; }
@keyframes slideIn { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
</style>
