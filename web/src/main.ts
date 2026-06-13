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
app.use(createPinia());
app.use(i18n);
app.mount("#app");
