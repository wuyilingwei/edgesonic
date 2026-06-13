import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { createPinia } from "pinia";
import { i18n } from "./i18n";
import App from "./App.vue";
import Login from "./views/Login.vue";
import Dashboard from "./views/Dashboard.vue";
import Library from "./views/Library.vue";
import Sources from "./views/Sources.vue";
import Files from "./views/Files.vue";
import Users from "./views/Users.vue";
import Settings from "./views/Settings.vue";
import Transcoder from "./views/Transcoder.vue";

const routes = [
  { path: "/login", component: Login, meta: { title: "Login", public: true } },
  { path: "/", component: Dashboard, meta: { title: "Dashboard" } },
  { path: "/library", component: Library, meta: { title: "Library" } },
  { path: "/sources", component: Sources, meta: { title: "Sources" } },
  { path: "/files", component: Files, meta: { title: "Files" } },
  { path: "/users", component: Users, meta: { title: "Users" } },
  // Permissions matrix now lives inside Settings; keep the old route working.
  { path: "/permissions", redirect: "/settings" },
  { path: "/settings", component: Settings, meta: { title: "Settings" } },
  { path: "/transcoder", component: Transcoder, meta: { title: "Transcoder" } },
  // 062 — Internet Radio management. Lazy-loaded; view is rarely needed by
  // non-admin users so we keep it out of the main chunk.
  { path: "/radio", component: () => import("./views/Radio.vue"), meta: { title: "Radio" } },
  // 063 — Podcast subscription management.
  { path: "/podcasts", component: () => import("./views/Podcasts.vue"), meta: { title: "Podcasts" } },
  // 061 — Public Share creation & management.
  { path: "/shares", component: () => import("./views/Shares.vue"), meta: { title: "Shares" } },
  // 069 — Playlist CRUD UI. Lazy loaded; no nested detail route — the view
  // owns its detail state inline so back-nav doesn't re-pick a playlist.
  { path: "/playlists", component: () => import("./views/Playlists.vue"), meta: { title: "Playlists" } },
];

const router = createRouter({ history: createWebHashHistory(), routes });

// 导航守卫：未登录跳 /login
router.beforeEach((to) => {
  const loggedIn = !!localStorage.getItem("edgesonic_auth");
  if (!to.meta.public && !loggedIn) return "/login";
  if (to.path === "/login" && loggedIn) return "/";
  return true;
});

const app = createApp(App);
app.use(router);
const pinia = createPinia();
app.use(pinia);
app.use(i18n);
app.mount("#app");

// 081 — Long-lived SPA tabs can sit on a stale bundle for hours after a worker
// deploy. We poll a tiny public endpoint and feed the result into the update
// banner store; the banner only renders once the version or isolate start time
// differs from the first sample we recorded.
//
// Initial probe runs 5s after mount (give the auth bootstrap room to breathe),
// then every 5 minutes thereafter. Errors are deliberately swallowed — a
// transient blip must NOT trigger a banner.
import { useUpdateBanner } from "./stores/updateBanner";

const VERSION_POLL_INTERVAL_MS = 5 * 60 * 1000;
const VERSION_FIRST_PROBE_DELAY_MS = 5_000;

async function checkVersion() {
  try {
    const banner = useUpdateBanner(pinia);
    const r = await fetch("/edgesonic/version", { cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as { ok?: boolean; version?: string; startedAt?: string };
    if (!j.ok || typeof j.version !== "string" || typeof j.startedAt !== "string") return;
    banner.notify({ version: j.version, startedAt: j.startedAt });
  } catch {
    // Network blip / offline tab: ignore. We'll retry next interval.
  }
}

setTimeout(() => {
  void checkVersion();
  setInterval(() => {
    void checkVersion();
  }, VERSION_POLL_INTERVAL_MS);
}, VERSION_FIRST_PROBE_DELAY_MS);
