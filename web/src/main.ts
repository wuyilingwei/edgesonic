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

import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { createPinia } from "pinia";
import { i18n } from "./i18n";
import "./theme"; // side-effect: applies saved theme attribute before first paint
import App from "./App.vue";
import Login from "./views/Login.vue";
import Dashboard from "./views/Dashboard.vue";
import Library from "./views/Library.vue";
import Sources from "./views/Sources.vue";
import Files from "./views/Files.vue";
import Users from "./views/Users.vue";
import Settings from "./views/Settings.vue";
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
  // Settings. Lazy-loaded — super-admin workflows, rarely visited.
  { path: "/tools", component: () => import("./views/Tools.vue"), meta: { title: "Tools" } },
  // non-admin users so we keep it out of the main chunk.
  { path: "/radio", component: () => import("./views/Radio.vue"), meta: { title: "Radio" } },
  { path: "/podcasts", component: () => import("./views/Podcasts.vue"), meta: { title: "Podcasts" } },
  { path: "/shares", component: () => import("./views/Shares.vue"), meta: { title: "Shares" } },
  // owns its detail state inline so back-nav doesn't re-pick a playlist.
  { path: "/playlists", component: () => import("./views/Playlists.vue"), meta: { title: "Playlists" } },
  { path: "/now-playing", component: () => import("./views/NowPlaying.vue"), meta: { title: "Now Playing" } },
];

const router = createRouter({ history: createWebHashHistory(), routes });

// 导航守卫：未登录跳 /login
router.beforeEach((to) => {
  // After the httpOnly-cookie upgrade the SPA no longer keeps the session
  // token in localStorage, only a non-secret "logged in" flag — see
  // api.ts's login(). If the cookie has actually expired server-side, the
  // first authenticated fetch will 401/403 and handleAuthError redirects
  // to /login anyway, so this guard is purely to avoid a half-loaded SPA
  // flash on a tab that opened after the cookie expired.
  const loggedIn = !!localStorage.getItem("edgesonic_logged_in");
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

// P6 — save the interval handle so it is GC-eligible; skip the request
// whenever the tab is hidden (document.hidden) to avoid network noise while
// the user has EdgeSonic open in a background tab.
let versionPollIntervalId: ReturnType<typeof setInterval> | null = null;

setTimeout(() => {
  void checkVersion();
  versionPollIntervalId = setInterval(() => {
    if (document.hidden) return; // tab not visible — skip, retry next tick
    void checkVersion();
  }, VERSION_POLL_INTERVAL_MS);
}, VERSION_FIRST_PROBE_DELAY_MS);

// Export the handle so HMR / test teardown can clear it if needed.
export { versionPollIntervalId };
