
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth } from "./api";
import PlayerBar from "./components/PlayerBar.vue";
import UpdateBanner from "./components/UpdateBanner.vue";
import Icon from "./components/Icon.vue";
import { usePlayerStore } from "./stores/player";
import { useWorkerPool } from "./stores/workerPool";
import { useDemoMode } from "./stores/demoMode";
import { activeTheme, resetTheme, restoreSavedTheme } from "./theme";
import { getTheme } from "./themes/registry";
import { ensureBuiltinThemeLoaded } from "./themes/builtin";
import { activeToast, dismissToast } from "./stores/toast";

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const { isLoggedIn, level, logout, hasPerm, fetchMe, displayName } = useAuth();
const player = usePlayerStore();
const workerPool = useWorkerPool();
const demoMode = useDemoMode();
watch(isLoggedIn, (now) => {
  if (now) {
    // Refresh real effective permissions so nav gates by capability, not just
    // level (covers reloads where login()'s fetchMe never ran this session).
    void fetchMe();
    void restoreSavedTheme();
    void workerPool.hydrateConfig().then(() => workerPool.start());
    player.resumePlaybackIfNeeded();
  } else {
    resetTheme();
    workerPool.reset();
  }
}, { immediate: true });

const menuOpen = ref(false);
watch(() => route.path, () => { menuOpen.value = false; });

function openMenuFromLogo() {
  menuOpen.value = true;
}

function collapseNowPlaying() {
  if (window.history.length > 1) router.back();
  else void router.push("/library");
}

const pageTransitionName = ref("page");
router.beforeEach((to, from) => {
  if (to.path === "/now-playing") pageTransitionName.value = "expand";
  else if (from.path === "/now-playing") pageTransitionName.value = "collapse";
  else pageTransitionName.value = "page";
  return true;
});

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const levelLabel = computed(() => levelKeys[level.value] ? t(`app.levels.${levelKeys[level.value]}`) : String(level.value));

// `perm` gates a nav item on real effective capability (from /auth/me), not
// just level: an admin without manage_users sees no Users tab, without
// manage_sources no Sources tab, etc. An array is any-of (Tools serves several
// admin capabilities). `minLevel` is only a coarse floor (guests never
// manage). Settings sits in the bottom group and is visible to every signed-in
// user — its advanced section gates on manage_settings inside.
interface NavItem { label: string; path: string; minLevel: number; perm?: string | string[]; icon?: string; }
interface NavGroup { label: string; items: NavItem[]; }

function permitted(perm?: string | string[]): boolean {
  if (!perm) return true;
  return Array.isArray(perm) ? perm.some(hasPerm) : hasPerm(perm);
}

const groups = computed<NavGroup[]>(() => {
  const defs: NavGroup[] = [
    {
      label: t("app.groups.library"),
      items: [
        { label: t("app.menu.dashboard"), path: "/", minLevel: 0 },
        { label: t("app.menu.library"), path: "/library", minLevel: 0 },
        { label: t("app.menu.starred"), path: "/starred", minLevel: 0 },
        { label: t("app.menu.playlists"), path: "/playlists", minLevel: 0 },
        { label: t("app.menu.radio"), path: "/radio", minLevel: 0 },
        { label: t("app.menu.podcasts"), path: "/podcasts", minLevel: 0 },
        { label: t("app.menu.shares"), path: "/shares", minLevel: 0 },
      ],
    },
    {
      label: t("app.groups.management"),
      items: [
        { label: t("app.menu.files"), path: "/files", minLevel: 1, perm: "manage_files" },
        { label: t("app.menu.sources"), path: "/sources", minLevel: 1, perm: "manage_sources" },
        { label: t("app.menu.users"), path: "/users", minLevel: 1, perm: "manage_users" },
        // Tools hosts the Subsonic sync (clone-to-self), which every non-guest
        // may use; admin-only tools inside gate themselves individually.
        { label: t("app.menu.tools"), path: "/tools", minLevel: 1 },
      ],
    },
    {
      label: t("app.groups.help"),
      items: [
        { label: t("app.menu.settings"), path: "/settings", minLevel: 0 },
        { label: t("app.menu.about"), path: "/about", minLevel: 0 },
      ],
    },
  ];
  return defs
    .map((g) => ({ ...g, items: g.items.filter((i) => level.value >= i.minLevel && permitted(i.perm)) }))
    .filter((g) => g.items.length > 0);
});

function doLogout() {
  player.clear();
  workerPool.reset();
  logout();
  router.push("/login");
}

const loadedThemeDef = ref<ReturnType<typeof getTheme>>();
const activeThemeDef = computed(() => getTheme(activeTheme.value) ?? loadedThemeDef.value);
let themeLoadId = 0;
watch(
  activeTheme,
  async (theme) => {
    const loadId = ++themeLoadId;
    await ensureBuiltinThemeLoaded(theme);
    if (loadId === themeLoadId) loadedThemeDef.value = getTheme(theme);
  },
  { immediate: true },
);

const bgHostEl = ref<HTMLElement | null>(null);
let bgCleanup: (() => void) | null = null;
watch(
  [activeThemeDef, bgHostEl],
  ([def, host]) => {
    bgCleanup?.();
    bgCleanup = null;
    if (def?.mountBackground && host) bgCleanup = def.mountBackground(host);
  },
  { immediate: true, flush: "post" },
);
onBeforeUnmount(() => { bgCleanup?.(); bgCleanup = null; });
</script>

<template>
  <component :is="activeThemeDef?.background" v-if="activeThemeDef?.background" />
  <div v-else-if="activeThemeDef?.mountBackground" ref="bgHostEl" aria-hidden="true"></div>

  <UpdateBanner />

  <div v-if="demoMode.enabled" class="demo-badge" role="status" aria-live="polite">
    <span class="demo-badge-text">{{ t("demo.badge") }}</span>
  </div>

  <Transition name="toast">
    <button
      v-if="activeToast"
      type="button"
      :class="['toast', `toast-${activeToast.type}`, 'app-toast']"
      role="alert"
      @click="dismissToast"
    >
      <span aria-hidden="true"><Icon :name="activeToast.type === 'error' ? 'cross' : activeToast.type === 'success' ? 'check' : 'info'" /></span>
      {{ activeToast.message }}
    </button>
  </Transition>

  <!-- 未登录：全屏渲染（Login） -->
  <router-view v-if="!isLoggedIn" />

  <!-- 登录后框架：NavBar + Sidebar + Main + PlayerBar -->
  <div v-else class="shell" :class="{ 'now-playing-shell': route.path === '/now-playing' }">
    <nav class="navbar">
      <!-- left: logo; on mobile it toggles the sidebar -->
      <div class="nav-left">
        <button
          class="nav-logo nav-logo-menu"
          aria-controls="main-sidebar"
          :aria-expanded="menuOpen"
          :aria-label="t('app.openNavigation')"
          @click="openMenuFromLogo"
        >
          <img src="/logo.svg" alt="EdgeSonic" class="nav-logo-img" />
          <span class="logo-text">EDGESONIC</span>
        </button>
        <router-link to="/" class="nav-logo nav-logo-home">
          <img src="/logo.svg" alt="EdgeSonic" class="nav-logo-img" />
          <span class="logo-text">EDGESONIC</span>
        </router-link>
      </div>

      <!-- right: user -->
      <div class="nav-user">
        <span class="nav-username">{{ displayName }}</span>
        <span class="status-badge" :class="level >= 3 ? 'warning' : level >= 2 ? 'info' : 'muted'">{{ levelLabel }}</span>
        <button class="btn-secondary btn-sm" @click="doLogout">{{ t("app.logout") }}</button>
      </div>

      <div class="nav-scanline"></div>
    </nav>

    <button
      v-if="route.path === '/now-playing'"
      class="now-playing-collapse"
      type="button"
      :title="t('player.collapse')"
      :aria-label="t('player.collapse')"
      @click="collapseNowPlaying"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6z"/></svg>
    </button>

    <div class="sidebar-overlay" :class="{ open: menuOpen }" @click="menuOpen = false"></div>

    <aside id="main-sidebar" class="sidebar" :class="{ open: menuOpen }">
      <div class="sidebar-scroll">
        <div v-for="g in groups" :key="g.label" class="nav-group">
          <div class="nav-group-label">{{ g.label }}</div>
          <router-link
            v-for="item in g.items"
            :key="item.path"
            :to="item.path"
            class="side-link"
            :class="{ active: item.path === '/' ? route.path === '/' : route.path.startsWith(item.path) }"
          >
           <span v-if="item.icon" class="side-emoji" aria-hidden="true">{{ item.icon }}</span>{{ item.label }}
          </router-link>
        </div>
      </div>

      <div
        class="sidebar-footer-spacer"
        :style="{ height: `${activeThemeDef?.sidebarFooterHeight ?? 0}px` }"
        aria-hidden="true"
      ></div>
    </aside>

    <main class="main">
      <router-view v-slot="{ Component, route: activeRoute }">
        <transition :name="pageTransitionName" mode="out-in">
          <component :is="Component" :key="activeRoute.path" />
        </transition>
      </router-view>
    </main>

    <PlayerBar />
  </div>
</template>

<style>
@import "./assets/palette.css";
@import "./assets/decor.css";

/* === App shell === */
.shell,
.login-view {
  position: relative;
  z-index: 1;
}
.shell { min-height: 100vh; }
.app-toast {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  max-width: min(28rem, calc(100vw - 2rem));
  text-align: left;
  cursor: pointer;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.34);
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(0.5rem); }
.shell.now-playing-shell {
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

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
.nav-left {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 1.25rem;
}
.nav-logo {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--font-mono);
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--color-accent-primary);
  line-height: 1;
  white-space: nowrap;
  text-decoration: none;
}
.nav-logo-menu { display: none; }
.nav-logo-img {
  height: 38px;
  width: 38px;
  object-fit: contain;
  display: block;
}
.nav-links { display: flex; gap: 1.25rem; }
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
.nav-user { display: flex; align-items: center; gap: 0.7rem; flex: 1; justify-content: flex-end; }
.nav-username {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
  letter-spacing: 0.05em;
  max-width: 140px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.now-playing-collapse {
  position: fixed;
  top: calc(var(--nav-h) + 0.75rem);
  left: calc(var(--sidebar-w) + 1.75rem);
  z-index: 130;
  display: none;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-bg-secondary) 78%, transparent);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  transition: color 0.2s, border-color 0.2s, background 0.2s;
}
.now-playing-collapse:hover {
  color: var(--color-accent-primary);
  border-color: var(--color-border-strong);
  background: var(--color-bg-tertiary);
}
/* --- Sidebar (240px) ---
 * .sidebar is the fixed flex host; only .sidebar-scroll (the nav-group
 * list) scrolls. .sidebar-footer-spacer is an empty reserved spacer below
 * it, sized per-theme (see themes/registry.ts's sidebarFooterHeight) — a
 * theme can fade .sidebar's own background to transparent across exactly
 * that height from its own stylesheet, so a shared page-wide background
 * shows through instead of needing a second, separate widget here.
 */
.sidebar {
  position: fixed;
  top: var(--nav-h);
  bottom: var(--player-h);
  left: 0;
  width: var(--sidebar-w);
  z-index: 150;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  transition: transform 0.25s ease, background 0.25s ease;
}
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  padding: 1.25rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
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
/* optional emoji prefix inside .side-link — generic for future nav items. */
.side-emoji {
  display: inline-block;
  margin-right: 0.45rem;
  font-size: 0.95em;
  vertical-align: -1px;
}
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 140;
  background: var(--color-bg-overlay);
  touch-action: none;
}

/* Reserved space at the bottom of the sidebar flex column, sized from the
 * active theme's `sidebarFooterHeight` (0 for themes that don't set one —
 * see themes/registry.ts). A theme that wants this space to visually bleed
 * into a shared page background does so via its own stylesheet targeting
 * `.sidebar` directly (e.g. themes/elements/elements.css); this file never
 * mentions any specific theme.
 */
.sidebar-footer-spacer {
  flex-shrink: 0;
}

/* --- Main content --- */
.main {
  margin-left: var(--sidebar-w);
  padding: calc(var(--nav-h) + 1.5rem) 1.75rem calc(var(--player-h) + 1.5rem);
  min-height: 100vh;
}
.now-playing-shell .main {
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.now-playing-shell .nowplaying {
  height: auto;
  flex: 1;
  min-height: 0;
}

/* --- Page transitions ---
 * "page": plain navigation between regular views.
 * "expand"/"collapse": entering/leaving /now-playing — a bottom-sheet motion
 * that reads as the detail view growing out of (and shrinking back into) the
 * player bar it's opened from.
 */
.page-enter-active, .page-leave-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.page-enter-from { opacity: 0; transform: translateY(8px); }
.page-leave-to { opacity: 0; transform: translateY(-8px); }

.expand-enter-active { transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
.expand-enter-from { opacity: 0; transform: translateY(48px) scale(0.97); }
.expand-leave-active { transition: opacity 0.15s ease; }
.expand-leave-to { opacity: 0; }

.collapse-enter-active { transition: opacity 0.2s ease; }
.collapse-enter-from { opacity: 0; }
.collapse-leave-active { transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.4, 0, 1, 1); }
.collapse-leave-to { opacity: 0; transform: translateY(48px) scale(0.97); }

/* --- Responsive: ≤960px 侧栏由 Logo 展开 --- */
@media (max-width: 960px) {
  .nav-logo-home { display: none; }
  .nav-logo-menu { display: flex; }
  .nav-links { display: none; }
  .nav-username { display: none; }
  .sidebar { transform: translateX(-100%); bottom: 0; box-shadow: 8px 0 40px rgba(0, 0, 0, 0.6); }
  .sidebar.open { transform: translateX(0); }
  .sidebar-overlay.open { display: block; }
  .main { margin-left: 0; padding-left: 1rem; padding-right: 1rem; }
  .now-playing-collapse { display: inline-flex; left: 1rem; }
}

/* --- Demo mode badge --- */
.demo-badge {
  position: fixed;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2000;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  background: rgba(255, 165, 0, 0.85);
  color: #1a1a1a;
  font-size: 0.72rem;
  font-weight: 600;
  border-radius: 999px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.demo-badge-text { white-space: nowrap; }
</style>
