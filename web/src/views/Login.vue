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
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";

const { t } = useI18n();
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
  else error.value = result.error || t("login.failed");
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">
          <img src="/logo.svg" alt="EdgeSonic" class="login-logo-img" />
          <span class="logo-text">EDGESONIC</span>
        </div>
        <p class="login-subtitle">{{ t("login.subtitle") }}</p>
      </div>

      <form @submit.prevent="submit" class="login-form">
        <div v-if="error" class="login-error">{{ error }}</div>

        <div class="form-group">
          <label class="form-label">{{ t("login.username") }}</label>
          <input v-model="username" class="form-input" autocomplete="username" :disabled="loading" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("login.password") }}</label>
          <input v-model="password" type="password" class="form-input" autocomplete="current-password" :disabled="loading" />
        </div>

        <button type="submit" class="btn-primary login-btn" :disabled="loading || !username || !password">
          {{ loading ? t("login.submitting") : t("login.submit") }}
        </button>
      </form>

      <div class="corner corner-tl"></div>
      <div class="corner corner-tr"></div>
      <div class="corner corner-bl"></div>
      <div class="corner corner-br"></div>
    </div>
  </div>
</template>

<style scoped>
.login-view {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-primary);
  background-image:
    linear-gradient(var(--color-border-subtle) 1px, transparent 1px),
    linear-gradient(90deg, var(--color-border-subtle) 1px, transparent 1px);
  background-size: 64px 64px;
  padding: 1rem;
}

.login-card {
  position: relative;
  width: 100%;
  max-width: 400px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
}

.login-header {
  padding: 2rem 2rem 1rem;
  text-align: center;
  border-bottom: 1px solid var(--color-border-subtle);
}

.login-logo {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}
.login-logo-img {
  height: 56px;
  width: 56px;
  object-fit: contain;
}
.login-logo .logo-text {
  font-family: var(--font-mono);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-accent-primary);
  letter-spacing: 0.15em;
}

.login-subtitle {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.3em;
  text-transform: uppercase;
}

.login-form {
  padding: 1.5rem 2rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.login-error {
  background: rgba(248, 81, 73, 0.12);
  border: 1px solid rgba(248, 81, 73, 0.4);
  color: var(--color-status-error);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  padding: 0.5rem 0.75rem;
  border-radius: 2px;
}

.login-btn { width: 100%; margin-top: 0.5rem; }
</style>
