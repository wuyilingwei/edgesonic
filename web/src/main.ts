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
import App from "./App.vue";
import Login from "./views/Login.vue";
import Dashboard from "./views/Dashboard.vue";
import Sources from "./views/Sources.vue";
import Files from "./views/Files.vue";
import Users from "./views/Users.vue";
import Transcoder from "./views/Transcoder.vue";

const routes = [
  { path: "/login", component: Login },
  { path: "/", component: Dashboard },
  { path: "/sources", component: Sources },
  { path: "/files", component: Files },
  { path: "/users", component: Users },
  { path: "/transcoder", component: Transcoder },
];

const router = createRouter({ history: createWebHashHistory(), routes });

const app = createApp(App);
app.use(router);
app.use(createPinia());
app.mount("#app");
