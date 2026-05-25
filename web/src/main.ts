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
