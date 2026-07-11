<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth } from "./api";
import PlayerBar from "./components/PlayerBar.vue";
import UpdateBanner from "./components/UpdateBanner.vue";
import { usePlayerStore } from "./stores/player";
import { useWorkerPool } from "./stores/workerPool";
import { activeTheme } from "./theme";

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const { isLoggedIn, username, level, logout } = useAuth();
const player = usePlayerStore();
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

// Page-switch transition: entering/leaving /now-playing gets a bottom-sheet
// "expand"/"collapse" motion that echoes the player bar it opens from;
// regular navigation between other pages gets a plain fade/slide. Decided in
// beforeEach (not a computed on route.path) so we know both the `to` and
// `from` side of the navigation before the transition starts.
const pageTransitionName = ref("page");
router.beforeEach((to, from) => {
  if (to.path === "/now-playing") pageTransitionName.value = "expand";
  else if (from.path === "/now-playing") pageTransitionName.value = "collapse";
  else pageTransitionName.value = "page";
  return true;
});

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };
const levelLabel = computed(() => levelKeys[level.value] ? t(`app.levels.${levelKeys[level.value]}`) : String(level.value));

// optional `icon` prefix per item — generic slot for future nav items.
interface NavItem { label: string; path: string; minLevel: number; icon?: string; }
interface NavGroup { label: string; items: NavItem[]; }

const groups = computed<NavGroup[]>(() => {
  const defs: NavGroup[] = [
    {
      label: t("app.groups.library"),
      items: [
        { label: t("app.menu.dashboard"), path: "/", minLevel: 0 },
        { label: t("app.menu.library"), path: "/library", minLevel: 0 },
        { label: t("app.menu.playlists"), path: "/playlists", minLevel: 0 },
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
        { label: t("app.menu.tools"), path: "/tools", minLevel: 3 },
        { label: t("app.menu.settings"), path: "/settings", minLevel: 3 },
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

// === stardust theme: celestial geometry background ===
// Light Stardust mode adds slow cube/hexagram/star motion behind every page.
// Randomized once per mount rather than fixed nth-child CSS so reloads feel
// slightly alive without introducing runtime animation state.
const isStardust = computed(() => activeTheme.value === "stardust");
interface DriftCube { top: string; size: string; duration: string; delay: string; spin: string; opacity: number; }
interface StardustSpark { left: string; top: string; size: string; duration: string; delay: string; opacity: number; }
interface StardustHex { left: string; top: string; size: string; duration: string; delay: string; opacity: number; }
function randomCube(): DriftCube {
  const size = 22 + Math.random() * 34;
  return {
    top: `${Math.random() * 90}vh`,
    size: `${size}px`,
    duration: `${26 + Math.random() * 26}s`,
    delay: `-${Math.random() * 30}s`,
    spin: `${9 + Math.random() * 16}s`,
    opacity: 0.2 + Math.random() * 0.28,
  };
}
function randomSpark(): StardustSpark {
  const size = 6 + Math.random() * 12;
  return {
    left: `${Math.random() * 100}vw`,
    top: `${Math.random() * 100}vh`,
    size: `${size}px`,
    duration: `${3.5 + Math.random() * 5}s`,
    delay: `-${Math.random() * 8}s`,
    opacity: 0.35 + Math.random() * 0.4,
  };
}
function randomHex(): StardustHex {
  const size = 80 + Math.random() * 130;
  return {
    left: `${Math.random() * 100}vw`,
    top: `${Math.random() * 100}vh`,
    size: `${size}px`,
    duration: `${18 + Math.random() * 24}s`,
    delay: `-${Math.random() * 20}s`,
    opacity: 0.08 + Math.random() * 0.11,
  };
}
const driftCubes = Array.from({ length: 6 }, randomCube);
const stardustSparks = Array.from({ length: 26 }, randomSpark);
const stardustHexes = Array.from({ length: 5 }, randomHex);
</script>

<template>
  <div v-if="isStardust" class="stardust-bg" aria-hidden="true">
    <div
      v-for="(h, i) in stardustHexes"
      :key="`h-${i}`"
      class="stardust-hex"
      :style="{ left: h.left, top: h.top, width: h.size, height: h.size, animationDuration: h.duration, animationDelay: h.delay, opacity: h.opacity }"
    ></div>
    <i
      v-for="(s, i) in stardustSparks"
      :key="`s-${i}`"
      class="stardust-spark"
      :style="{ left: s.left, top: s.top, width: s.size, height: s.size, animationDuration: s.duration, animationDelay: s.delay, opacity: s.opacity }"
    ></i>
    <div
      v-for="(c, i) in driftCubes"
      :key="`c-${i}`"
      class="star-cube-drift"
      :style="{ top: c.top, animationDuration: c.duration, animationDelay: c.delay, opacity: c.opacity, '--cube-half': `calc(${c.size} / 2)` }"
    >
      <div class="star-cube-spin" :style="{ width: c.size, height: c.size, animationDuration: c.spin }">
        <span class="cube-face cube-front"></span>
        <span class="cube-face cube-back"></span>
        <span class="cube-face cube-top"></span>
        <span class="cube-face cube-bottom"></span>
        <span class="cube-face cube-left"></span>
        <span class="cube-face cube-right"></span>
      </div>
    </div>
  </div>

  <UpdateBanner />

  <!-- 未登录：全屏渲染（Login） -->
  <router-view v-if="!isLoggedIn" />

  <!-- 登录后框架：NavBar + Sidebar + Main + PlayerBar -->
  <div v-else class="shell">
    <nav class="navbar">
      <!-- left: logo + hamburger -->
      <div class="nav-left">
        <router-link to="/" class="nav-logo">
          <img src="/logo.svg" alt="EdgeSonic" class="nav-logo-img" />
          <span class="logo-text">EDGESONIC</span>
        </router-link>
        <button class="hamburger" @click="menuOpen = !menuOpen">☰</button>
      </div>

      <!-- right: user -->
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
         <span v-if="item.icon" class="side-emoji" aria-hidden="true">{{ item.icon }}</span>{{ item.label }}
        </router-link>
      </div>
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

/* === stardust theme: celestial background ===
 * Hexagrams rotate slowly, yellow sparks pulse, and cube props drift across
 * the light page. Kept CSS-only and behind content for cheap compositing.
 */
.stardust-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    linear-gradient(115deg, rgba(255,255,255,0.18), rgba(107,99,255,0.06), rgba(255,214,74,0.08)),
    radial-gradient(circle at 20% 25%, rgba(154,123,255,0.16), transparent 28rem),
    radial-gradient(circle at 80% 10%, rgba(111,199,255,0.18), transparent 24rem),
    radial-gradient(circle at 62% 86%, rgba(255,214,74,0.18), transparent 26rem);
}
.stardust-hex {
  position: absolute;
  transform: translate(-50%, -50%);
  animation: stardustHexSpin linear infinite;
  filter: drop-shadow(0 0 18px rgba(107, 99, 255, 0.18));
}
.stardust-hex::before,
.stardust-hex::after {
  content: "";
  position: absolute;
  inset: 16%;
  clip-path: polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%);
  border: 1px solid rgba(107, 99, 255, 0.5);
  background: linear-gradient(135deg, rgba(107,99,255,0.05), rgba(255,214,74,0.08));
}
.stardust-hex::after {
  transform: rotate(30deg) scale(0.72);
  border-color: rgba(255, 214, 74, 0.75);
}
.stardust-spark {
  position: absolute;
  display: block;
  transform: translate(-50%, -50%) rotate(45deg);
  background: var(--color-stardust-gold);
  clip-path: polygon(50% 0%, 61% 36%, 100% 50%, 61% 64%, 50% 100%, 39% 64%, 0% 50%, 39% 36%);
  box-shadow: 0 0 18px rgba(255, 214, 74, 0.75);
  animation: stardustSparkPulse ease-in-out infinite;
}
.star-cube-drift {
  position: absolute;
  left: 0;
  perspective: 700px;
  animation: cubeDrift linear infinite;
}
.star-cube-spin {
  transform-style: preserve-3d;
  animation: cubeSpin linear infinite;
  filter: drop-shadow(0 0 12px rgba(107, 99, 255, 0.3));
}
.cube-face {
  position: absolute;
  inset: 0;
  border: 1px solid rgba(107, 99, 255, 0.42);
  background: linear-gradient(135deg, rgba(107, 99, 255, 0.12), rgba(255, 214, 74, 0.18));
}
.cube-front  { transform: translateZ(var(--cube-half)); }
.cube-back   { transform: translateZ(calc(var(--cube-half) * -1)) rotateY(180deg); }
.cube-right  { transform: rotateY(90deg) translateZ(var(--cube-half)); }
.cube-left   { transform: rotateY(-90deg) translateZ(var(--cube-half)); }
.cube-top    { transform: rotateX(90deg) translateZ(var(--cube-half)); }
.cube-bottom { transform: rotateX(-90deg) translateZ(var(--cube-half)); }

@keyframes cubeDrift {
  from { transform: translateX(-10vw); }
  to   { transform: translateX(110vw); }
}
@keyframes cubeSpin {
  from { transform: rotateX(0deg) rotateY(0deg); }
  to   { transform: rotateX(360deg) rotateY(360deg); }
}
@keyframes stardustHexSpin {
  from { transform: translate(-50%, -50%) rotate(0deg) scale(0.92); }
  50%  { transform: translate(-50%, -50%) rotate(180deg) scale(1.04); }
  to   { transform: translate(-50%, -50%) rotate(360deg) scale(0.92); }
}
@keyframes stardustSparkPulse {
  0%, 100% { transform: translate(-50%, -50%) rotate(45deg) scale(0.7); filter: blur(0); }
  50% { transform: translate(-50%, -50%) rotate(45deg) scale(1.25); filter: blur(0.2px); }
}
@media (prefers-reduced-motion: reduce) {
  .stardust-bg { display: none; }
}

/* === App shell === */
.shell,
.login-view {
  position: relative;
  z-index: 1;
}
.shell { min-height: 100vh; }
:root[data-theme="stardust"] .login-view {
  background: transparent !important;
  background-image: none !important;
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
}

/* --- Main content --- */
.main {
  margin-left: var(--sidebar-w);
  padding: calc(var(--nav-h) + 1.5rem) 1.75rem calc(var(--player-h) + 1.5rem);
  min-height: 100vh;
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

/* --- Responsive: ≤960px 侧栏收起为汉堡 --- */
@media (max-width: 960px) {
  .hamburger { display: inline-flex; align-items: center; justify-content: center; }
  .nav-links { display: none; }
  .nav-username { display: none; }
  .sidebar { transform: translateX(-100%); bottom: 0; box-shadow: 8px 0 40px rgba(0, 0, 0, 0.6); }
  .sidebar.open { transform: translateX(0); }
  .sidebar-overlay.open { display: block; }
  .main { margin-left: 0; padding-left: 1rem; padding-right: 1rem; }
}
</style>
