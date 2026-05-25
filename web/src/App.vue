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
import { useRouter, useRoute } from "vue-router";

const router = useRouter();
const route = useRoute();

const navItems = [
  { label: "Dashboard", path: "/" },
  { label: "Files", path: "/files" },
  { label: "Sources", path: "/sources" },
  { label: "Transcoder", path: "/transcoder" },
  { label: "Users", path: "/users" },
];

function navigate(path: string) {
  router.push(path);
}
</script>

<template>
  <div class="app">
    <nav v-if="route.path !== '/login'" class="sidebar">
      <div class="logo">EdgeSonic</div>
      <ul>
        <li v-for="item in navItems" :key="item.path"
          :class="{ active: route.path === item.path }"
          @click="navigate(item.path)">
          {{ item.label }}
        </li>
      </ul>
    </nav>
    <main :class="{ full: route.path === '/login' }">
      <router-view />
    </main>
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e1e4e8; }
.app { display: flex; min-height: 100vh; }
.sidebar { width: 220px; background: #161b22; border-right: 1px solid #30363d; padding: 16px 0; }
.sidebar .logo { font-size: 18px; font-weight: 700; padding: 0 16px 16px; color: #79c0ff; }
.sidebar ul { list-style: none; }
.sidebar li { padding: 10px 16px; cursor: pointer; color: #8b949e; transition: .15s; }
.sidebar li:hover { background: #21262d; color: #c9d1d9; }
.sidebar li.active { background: #1f6feb22; color: #58a6ff; border-right: 2px solid #58a6ff; }
main { flex: 1; padding: 24px; overflow-y: auto; }
main.full { padding: 0; }
</style>
