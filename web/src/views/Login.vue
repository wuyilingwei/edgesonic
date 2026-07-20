
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";

const { t } = useI18n();
const { login, guestLogin, isLoggedIn } = useAuth();
const router = useRouter();
const route = useRoute();

const username = ref("");
const password = ref("");
const error = ref("");
const loading = ref(false);
const guestEnabled = ref(false);

if (isLoggedIn.value) router.push("/");

async function submit() {
  error.value = "";
  loading.value = true;
  try {
    const result = await login(username.value, password.value);
    if (result.ok) router.push("/");
    else error.value = result.error || t("login.failed");
  } catch {
    error.value = t("login.failed");
  } finally {
    loading.value = false;
  }
}

async function loginAsGuest() {
  error.value = "";
  loading.value = true;
  try {
    const result = await guestLogin();
    if (result.ok) router.push("/");
    else error.value = result.error || t("login.failed");
  } catch {
    error.value = t("login.failed");
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  // Demo/share links may prefill credentials with either short (`u` / `p`)
  // or descriptive (`username` / `password`) query keys. This only fills the
  // form; login still requires the visitor to press the submit button.
  const queryUsername = route.query.u ?? route.query.username;
  const queryPassword = route.query.p ?? route.query.password;
  if (typeof queryUsername === "string") username.value = queryUsername;
  if (typeof queryPassword === "string") password.value = queryPassword;
  try {
    const response = await fetch("/edgesonic/auth/guest", { credentials: "same-origin" });
    const data = await response.json();
    guestEnabled.value = data.ok && data.enabled === true;
  } catch {
    guestEnabled.value = false;
  }
});
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">
          <img src="/logo.svg" alt="EdgeSonic" class="login-logo-img" />
          <span class="logo-text">EDGESONIC</span>
        </div>
      </div>

      <form @submit.prevent="submit" class="login-form">
        <div v-if="error" class="login-error" role="alert">
          <span class="login-error-mark" aria-hidden="true">!</span>
          <span>{{ error }}</span>
        </div>

        <div class="form-group">
          <label class="form-label">{{ t("login.username") }}</label>
          <input v-model="username" maxlength="64" class="form-input" autocomplete="username" :disabled="loading" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t("login.password") }}</label>
          <input v-model="password" type="password" maxlength="256" class="form-input" autocomplete="current-password" :disabled="loading" />
        </div>

        <button type="submit" class="btn-primary login-btn" :disabled="loading || !username || !password">
          {{ loading ? t("login.submitting") : t("login.submit") }}
        </button>
        <button v-if="guestEnabled" type="button" class="btn-secondary login-btn" :disabled="loading" @click="loginAsGuest">
          {{ t("login.guest") }}
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
  height: 96px;
  width: 96px;
  object-fit: contain;
}
.login-logo .logo-text {
  font-family: var(--font-mono);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-accent-primary);
  letter-spacing: 0.15em;
}

.login-form {
  padding: 1.5rem 2rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.login-error {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-status-error);
  box-shadow: inset 3px 0 var(--color-status-error), 0 8px 18px rgba(0, 0, 0, 0.18);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  padding: 0.7rem 0.8rem;
  border-radius: 2px;
}
.login-error-mark {
  display: grid;
  width: 1.2rem;
  height: 1.2rem;
  place-items: center;
  flex: 0 0 auto;
  border: 1px solid currentColor;
  color: var(--color-status-error);
  font-weight: 700;
}

.login-btn { width: 100%; margin-top: 0.5rem; }
</style>
