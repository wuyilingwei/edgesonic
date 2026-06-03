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
const loading = ref(false);

if (isLoggedIn.value) router.push("/");

async function submit() {
  error.value = "";
  loading.value = true;
  const result = await login(username.value, password.value);
  loading.value = false;
  if (result.ok) router.push("/");
  else error.value = result.error || "Login failed";
}
</script>

<template>
  <div class="login-page">
    <!-- Background decoration -->
    <div class="bg-decor">
      <div class="decor-circle c1"></div>
      <div class="decor-circle c2"></div>
      <div class="decor-circle c3"></div>
    </div>

    <div class="login-card">
      <div class="card-icon">♪</div>
      <h1 class="card-title">EdgeSonic</h1>
      <p class="card-desc">Serverless Music Streaming</p>

      <form @submit.prevent="submit" class="login-form">
        <div class="form-group">
          <label class="form-label">Username</label>
          <input v-model="username" class="form-input" placeholder="Enter your username" autocomplete="username" />
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input v-model="password" type="password" class="form-input" placeholder="Enter your password" autocomplete="current-password" />
        </div>

        <button type="submit" class="btn btn-primary login-btn" :disabled="loading || !username || !password">
          <span v-if="loading" class="spinner"></span>
          <span v-else>Sign In</span>
        </button>

        <p v-if="error" class="error-msg">{{ error }}</p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh; background: var(--bg-primary);
  position: relative; overflow: hidden;
}
.bg-decor { position: absolute; inset: 0; pointer-events: none; }
.decor-circle {
  position: absolute; border-radius: 50%;
  opacity: 0.06; background: var(--accent);
}
.c1 { width: 600px; height: 600px; top: -200px; right: -150px; }
.c2 { width: 400px; height: 400px; bottom: -100px; left: -100px; }
.c3 { width: 200px; height: 200px; top: 50%; left: 60%; }

.login-card {
  position: relative; z-index: 1;
  width: 380px; padding: 36px 32px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
.card-icon {
  width: 48px; height: 48px; margin: 0 auto 16px;
  border-radius: 12px; background: var(--accent-bg);
  color: var(--accent); font-size: 24px;
  display: flex; align-items: center; justify-content: center;
}
.card-title {
  text-align: center; font-size: 22px; font-weight: 700;
  color: var(--text-primary); margin-bottom: 4px;
  letter-spacing: -0.5px;
}
.card-desc {
  text-align: center; font-size: 13px; color: var(--text-muted);
  margin-bottom: 28px;
}
.login-form { display: flex; flex-direction: column; gap: 16px; }
.form-label {
  display: block; font-size: 12px; font-weight: 600;
  color: var(--text-secondary); margin-bottom: 6px;
  text-transform: uppercase; letter-spacing: 0.5px;
}
.form-input {
  width: 100%; padding: 10px 14px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-primary); font-size: 14px;
  outline: none; transition: border-color 0.2s;
}
.form-input:focus { border-color: var(--accent); }
.form-input::placeholder { color: var(--text-muted); }

.login-btn {
  width: 100%; padding: 12px; margin-top: 4px;
  justify-content: center; font-size: 15px; border-radius: 8px;
}
.spinner {
  width: 18px; height: 18px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff; border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.error-msg {
  text-align: center; font-size: 13px; color: var(--danger);
  margin-top: 4px;
}
</style>
