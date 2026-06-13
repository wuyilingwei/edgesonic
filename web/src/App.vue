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
import { ref, computed, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth } from "./api";
import PlayerBar from "./components/PlayerBar.vue";
import { usePlayerStore } from "./stores/player";
import { useWorkerPool } from "./stores/workerPool";

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const { isLoggedIn, username, level, logout } = useAuth();
const player = usePlayerStore();
// 052 — browser worker pool. Auto-start once the user logs in (level >= 2
// AND opt-in flag stored locally); the store itself gates non-eligible users.
const workerPool = useWorkerPool();
watch(isLoggedIn, (now) => {
  if (now) {
    void workerPool.hydrateConfig().then(() => workerPool.start());
  } else {
    workerPool.reset();
  }
}, { immediate: true });

const menuOpen = ref(false);
watch(() => route.path, () => { menuOpen.value = false; });

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const levelLabel = computed(() => levelKeys[level.value] ? t(`app.levels.${levelKeys[level.value]}`) : String(level.value));

interface NavItem { label: string; path: string; minLevel: number; }
interface NavGroup { label: string; items: NavItem[]; }

const groups = computed<NavGroup[]>(() => {
  const defs: NavGroup[] = [
    {
      label: t("app.groups.library"),
      items: [
        { label: t("app.menu.dashboard"), path: "/", minLevel: 0 },
        { label: t("app.menu.library"), path: "/library", minLevel: 0 },
        { label: t("app.menu.radio"), path: "/radio", minLevel: 0 },
        { label: t("app.menu.podcasts"), path: "/podcasts", minLevel: 0 },
        { label: t("app.menu.shares"), path: "/shares", minLevel: 0 },
      ],
    },
    {
      label: t("app.groups.management"),
      items: [
        { label: t("app.menu.files"), path: "/files", minLevel: 2 },
        { label: t("app.menu.sources"), path: "/sources", minLevel: 2 },
        { label: t("app.menu.users"), path: "/users", minLevel: 2 },
        { label: t("app.menu.settings"), path: "/settings", minLevel: 3 },
        { label: t("app.menu.transcoder"), path: "/transcoder", minLevel: 2 },
      ],
    },
  ];
  return defs
    .map((g) => ({ ...g, items: g.items.filter((i) => level.value >= i.minLevel) }))
    .filter((g) => g.items.length > 0);
});

function doLogout() {
  player.clear();
  workerPool.reset();
  logout();
  router.push("/login");
}
</script>

<template>
  <!-- 未登录：全屏渲染（Login） -->
  <router-view v-if="!isLoggedIn" />

  <!-- 登录后框架：NavBar + Sidebar + Main + PlayerBar -->
  <div v-else class="shell">
    <nav class="navbar">
      <button class="hamburger" @click="menuOpen = !menuOpen">☰</button>
      <router-link to="/" class="nav-logo">
        <span class="logo-bracket">[</span>
        <span class="logo-text">EDGESONIC</span>
        <span class="logo-bracket">]</span>
      </router-link>

      <div class="nav-links">
        <router-link to="/" class="nav-link" :class="{ active: route.path === '/' }">
          <span class="link-prefix">// </span>{{ t("app.menu.dashboard") }}
        </router-link>
        <router-link to="/library" class="nav-link" :class="{ active: route.path.startsWith('/library') }">
          <span class="link-prefix">// </span>{{ t("app.menu.library") }}
        </router-link>
      </div>

      <div class="nav-user">
        <span class="nav-username">{{ username }}</span>
        <span class="status-badge" :class="level >= 3 ? 'warning' : level >= 2 ? 'info' : 'muted'">{{ levelLabel }}</span>
        <button class="btn-secondary btn-sm" @click="doLogout">{{ t("app.logout") }}</button>
      </div>
      <div class="nav-scanline"></div>
    </nav>

    <div class="sidebar-overlay" :class="{ open: menuOpen }" @click="menuOpen = false"></div>

    <aside class="sidebar" :class="{ open: menuOpen }">
      <div v-for="g in groups" :key="g.label" class="nav-group">
        <div class="nav-group-label">{{ g.label }}</div>
        <router-link
          v-for="item in g.items"
          :key="item.path"
          :to="item.path"
          class="side-link"
          :class="{ active: item.path === '/' ? route.path === '/' : route.path.startsWith(item.path) }"
        >
          {{ item.label }}
        </router-link>
      </div>
    </aside>

    <main class="main">
      <router-view />
    </main>

    <PlayerBar />
  </div>
</template>

<style>
@import "./assets/palette.css";

/* === App shell === */
.shell { min-height: 100vh; }

/* --- NavBar (fixed, 60px) --- */
.navbar {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 200;
  height: var(--nav-h);
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0 1.5rem;
  background: rgba(10, 10, 11, 0.92);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--color-border-subtle);
}
.nav-scanline {
  position: absolute;
  left: 0; right: 0; bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--color-accent-dim), transparent);
  animation: pulse 4s ease-in-out infinite;
  pointer-events: none;
}
.nav-logo {
  display: flex; align-items: center; gap: 2px;
  font-family: var(--font-mono);
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--color-accent-primary);
  flex-shrink: 0;
}
.logo-bracket { color: var(--color-text-muted); }
.nav-links { display: flex; gap: 1.25rem; flex: 1; }
.nav-link {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  transition: color 0.2s;
}
.nav-link:hover, .nav-link.active { color: var(--color-accent-primary); }
.link-prefix { color: var(--color-text-muted); }
.nav-user { display: flex; align-items: center; gap: 0.7rem; flex-shrink: 0; }
.nav-username {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
  letter-spacing: 0.05em;
  max-width: 140px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hamburger {
  display: none;
  color: var(--color-text-primary);
  font-size: 1.1rem;
  width: 32px; height: 32px;
}

/* --- Sidebar (240px) --- */
.sidebar {
  position: fixed;
  top: var(--nav-h);
  bottom: var(--player-h);
  left: 0;
  width: var(--sidebar-w);
  z-index: 150;
  overflow-y: auto;
  padding: 1.25rem 0.9rem;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  transition: transform 0.25s ease;
}
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-group-label {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.2em;
  color: var(--color-text-muted);
  text-transform: uppercase;
  padding: 0 0.6rem 0.4rem;
}
.side-link {
  display: block;
  padding: 0.45rem 0.6rem;
  font-size: var(--fs-md);
  color: var(--color-text-secondary);
  border-left: 2px solid transparent;
  border-radius: 0 2px 2px 0;
  transition: all 0.15s;
}
.side-link:hover { color: var(--color-text-primary); background: var(--color-bg-tertiary); }
.side-link.active {
  color: var(--color-accent-primary);
  background: var(--color-accent-dim);
  border-left-color: var(--color-accent-primary);
}
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 140;
  background: var(--color-bg-overlay);
}

/* --- Main content --- */
.main {
  margin-left: var(--sidebar-w);
  padding: calc(var(--nav-h) + 1.5rem) 1.75rem calc(var(--player-h) + 1.5rem);
  min-height: 100vh;
}

/* --- Responsive: ≤960px 侧栏收起为汉堡 --- */
@media (max-width: 960px) {
  .hamburger { display: inline-flex; align-items: center; justify-content: center; }
  .nav-links { display: none; }
  .sidebar { transform: translateX(-100%); bottom: 0; box-shadow: 8px 0 40px rgba(0, 0, 0, 0.6); }
  .sidebar.open { transform: translateX(0); }
  .sidebar-overlay.open { display: block; }
  .main { margin-left: 0; padding-left: 1rem; padding-right: 1rem; }
}
</style>
