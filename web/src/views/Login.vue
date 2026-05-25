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
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../api";

const { login, isLoggedIn } = useAuth();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref("");

if (isLoggedIn.value) router.push("/");

async function submit() {
  error.value = "";
  const result = await login(username.value, password.value);
  if (result.ok) router.push("/");
  else error.value = result.error || "Login failed";
}
</script>

<template>
  <div class="login-page">
    <div class="login-box">
      <h1>EdgeSonic</h1>
      <input v-model="username" placeholder="Username" @keyup.enter="submit" />
      <input v-model="password" type="password" placeholder="Password" @keyup.enter="submit" />
      <button @click="submit">Sign In</button>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0f1117; }
.login-box { width: 340px; padding: 32px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
.login-box h1 { text-align: center; margin-bottom: 24px; color: #79c0ff; font-size: 22px; }
.login-box input { width: 100%; padding: 10px 12px; margin-bottom: 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 14px; outline: none; }
.login-box input:focus { border-color: #58a6ff; }
.login-box button { width: 100%; padding: 10px; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 14px; cursor: pointer; }
.login-box button:hover { background: #2ea043; }
.error { color: #f85149; margin-top: 12px; font-size: 13px; text-align: center; }
</style>
