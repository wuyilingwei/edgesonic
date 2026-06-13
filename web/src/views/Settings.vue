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
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";
import { setLocale, SUPPORTED_LOCALES, type AppLocale } from "../i18n";
import PermissionsMatrix from "../components/PermissionsMatrix.vue";

const router = useRouter();
const { t, locale } = useI18n();
const { isSuperAdmin, authFetch, authPost, logout, username } = useAuth();

// === Accordion ===
type SectionKey = "common" | "sessions" | "clients" | "permissions";
const open = ref<Record<SectionKey, boolean>>({ common: true, sessions: false, clients: false, permissions: false });
function toggleSection(key: SectionKey) { open.value[key] = !open.value[key]; }

// === Toast ===
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

// === Common: language ===
const localeLabels: Record<AppLocale, string> = { "zh-CN": "中文（简体）", en: "English" };
function onLocaleChange(e: Event) {
  setLocale((e.target as HTMLSelectElement).value as AppLocale);
}

// === Common: features + instance ===
interface Feature { key: string; value: number; description: string; }
const features = ref<Feature[]>([]);
const instanceId = ref("");
const loading = ref(true);
const error = ref("");
const copied = ref(false);

async function loadFeatures() {
  loading.value = true;
  error.value = "";
  try {
    const text = await authFetch("getFeatures");
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "Request rejected");
    instanceId.value = data.instanceId || "";
    features.value = (data.features || []).map((f: Partial<Feature>) => ({
      key: f.key || "", value: Number(f.value) || 0, description: f.description || "",
    }));
  } catch (e: unknown) {
    // 后端契约可能尚未部署 —— 优雅降级显示错误（非 JSON 响应一律视为 API 不可用）
    error.value = e instanceof SyntaxError || !(e instanceof Error)
      ? t("settings.common.apiUnavailable")
      : e.message;
    features.value = [];
  }
  loading.value = false;
}

async function toggleFeature(f: Feature, checked: boolean) {
  const newValue = checked ? 1 : 0;
  const oldValue = f.value;
  f.value = newValue; // optimistic
  try {
    const text = await authPost("updateFeature", { key: f.key, value: newValue });
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "Update rejected");
    showToast(`${f.key} → ${newValue ? t("common.on") : t("common.off")}`);
  } catch {
    f.value = oldValue;
    showToast(t("settings.common.updateFailed", { key: f.key }), "error");
  }
}

async function copyInstanceId() {
  if (!instanceId.value) return;
  try {
    await navigator.clipboard.writeText(instanceId.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { showToast(t("settings.common.copyFailed"), "error"); }
}

// === Sessions ===
interface Session { id: string; userAgent: string; createdAt: number; expiresAt: number; }
const sessions = ref<Session[]>([]);
const sessionsLoading = ref(true);
const sessionsError = ref("");

function formatTs(epochSec: number): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString(locale.value);
}

async function loadSessions(): Promise<boolean> {
  sessionsLoading.value = true;
  sessionsError.value = "";
  try {
    const xml = await authFetch("getSessions");
    // 当前 session 被撤销后，签名校验失败 → status="failed" code="40"
    if (/status="failed"/.test(xml) && /code="40"/.test(xml)) {
      sessionsLoading.value = false;
      return false;
    }
    sessions.value = parseXmlAttrs(xml, "session").map((s) => ({
      id: s.id || "",
      userAgent: s.userAgent || "—",
      createdAt: parseInt(s.createdAt || "0"),
      expiresAt: parseInt(s.expiresAt || "0"),
    }));
  } catch {
    sessions.value = [];
    sessionsError.value = t("settings.sessions.loadFailed");
  }
  sessionsLoading.value = false;
  return true;
}

async function revokeSession(id: string) {
  if (!confirm(t("settings.sessions.confirmRevoke"))) return;
  try {
    const xml = await authPost("revokeSession", { id });
    if (/status="failed"/.test(xml)) throw new Error("revoke failed");
    showToast(t("settings.sessions.revoked"));
    // 若撤销的是当前 session，后续签名请求会 401 → 登出回 /login
    const stillValid = await loadSessions();
    if (!stillValid) {
      logout();
      router.push("/login");
    }
  } catch { showToast(t("settings.sessions.revokeFailed"), "error"); }
}

// === Subsonic client credentials ===
interface Credential { id: string; label: string; lastUsed: number; createdAt: number; }
const credentials = ref<Credential[]>([]);
const credLoading = ref(true);
const credError = ref("");
const credLabel = ref("");
const credBusy = ref(false);
const issued = ref<{ password: string; label: string } | null>(null);
const serverUrl = window.location.origin;

async function loadCredentials() {
  credLoading.value = true;
  credError.value = "";
  try {
    const xml = await authFetch("getCredentials");
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    credentials.value = parseXmlAttrs(xml, "credential").map((r) => ({
      id: r.id || "",
      label: r.label || "",
      lastUsed: parseInt(r.lastUsed || "0"),
      createdAt: parseInt(r.createdAt || "0"),
    }));
  } catch {
    credentials.value = [];
    credError.value = t("settings.clients.loadFailed");
  }
  credLoading.value = false;
}

function genPassword(): string {
  // unambiguous alphanumerics; 20 chars ≈ 119 bits of entropy
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint32Array(20);
  crypto.getRandomValues(buf);
  return Array.from(buf, (v) => chars[v % chars.length]).join("");
}

async function createCredential() {
  credBusy.value = true;
  const password = genPassword();
  const label = credLabel.value.trim();
  try {
    const xml = await authPost("createCredential", { password, label });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    issued.value = { password, label };
    credLabel.value = "";
    await loadCredentials();
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
  }
  credBusy.value = false;
}

async function deleteCredential(id: string) {
  if (!confirm(t("settings.sessions.confirmRevoke"))) return;
  try {
    const xml = await authPost("deleteCredential", { id });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    if (issued.value) issued.value = null;
    await loadCredentials();
  } catch { showToast(t("settings.clients.loadFailed"), "error"); }
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); showToast(t("common.copied")); }
  catch { showToast(t("settings.common.copyFailed"), "error"); }
}

onMounted(() => { loadFeatures(); loadSessions(); loadCredentials(); });
</script>

<template>
  <div class="settings">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("settings.label") }}</div>
        <h1 class="page-title">{{ t("settings.title") }}</h1>
      </div>
      <span v-if="!isSuperAdmin" class="status-badge warning">{{ t("settings.readOnly") }}</span>
    </div>

    <!-- ============ COMMON ============ -->
    <section class="settings-section card" :class="{ open: open.common }">
      <button class="section-header" @click="toggleSection('common')">
        <span class="section-title">{{ t("settings.common.title") }}</span>
        <span class="section-caret">{{ open.common ? "−" : "+" }}</span>
      </button>

      <div v-show="open.common" class="section-body">
        <!-- Instance ID -->
        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.instance") }}</span>
            <span class="status-badge" :class="instanceId ? 'success' : 'muted'">{{ instanceId ? t("settings.common.online") : t("settings.common.unknown") }}</span>
          </div>
          <div class="instance-row">
            <span class="mono-label">INSTANCE_ID</span>
            <code class="instance-id">{{ instanceId || "—" }}</code>
            <button class="btn-secondary btn-sm" :disabled="!instanceId" @click="copyInstanceId">
              {{ copied ? t("common.copied") : t("common.copy") }}
            </button>
          </div>
        </div>

        <!-- Language -->
        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.common.language") }}</span></div>
          <div class="lang-row">
            <span class="feature-desc">{{ t("settings.common.languageDesc") }}</span>
            <select class="form-select lang-select" :value="locale" @change="onLocaleChange">
              <option v-for="l in SUPPORTED_LOCALES" :key="l" :value="l">{{ localeLabels[l] }}</option>
            </select>
          </div>
        </div>

        <!-- Feature flags -->
        <div class="sub-block">
          <div class="sub-header"><span class="mono-label">{{ t("settings.common.featureFlags") }}</span></div>

          <div v-if="loading" class="empty-state">{{ t("common.loading") }}</div>

          <div v-else-if="error" class="error-panel">
            <span class="status-badge error">{{ t("settings.common.apiError") }}</span>
            <p class="error-text">{{ error }}</p>
            <button class="btn-secondary btn-sm" @click="loadFeatures">{{ t("common.retry") }}</button>
          </div>

          <div v-else-if="!features.length" class="empty-state">
            <div class="empty-state-icon">⚑</div>
            <div>{{ t("settings.common.noFeatures") }}</div>
          </div>

          <div v-else class="feature-list">
            <div v-for="f in features" :key="f.key" class="feature-row">
              <div class="feature-info">
                <code class="feature-key">{{ f.key }}</code>
                <span class="feature-desc">{{ f.description }}</span>
              </div>
              <label class="toggle" :title="isSuperAdmin ? '' : t('settings.common.levelRequired')">
                <input
                  type="checkbox"
                  :checked="f.value === 1"
                  :disabled="!isSuperAdmin"
                  @change="toggleFeature(f, ($event.target as HTMLInputElement).checked)"
                />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ SESSIONS ============ -->
    <section class="settings-section card" :class="{ open: open.sessions }">
      <button class="section-header" @click="toggleSection('sessions')">
        <span class="section-title">{{ t("settings.sessions.title") }}</span>
        <span class="section-caret">{{ open.sessions ? "−" : "+" }}</span>
      </button>

      <div v-show="open.sessions" class="section-body">
        <p class="feature-desc section-desc">{{ t("settings.sessions.desc") }}</p>

        <div v-if="sessionsLoading" class="empty-state">{{ t("common.loading") }}</div>

        <div v-else-if="sessionsError" class="error-panel">
          <span class="status-badge error">{{ t("settings.common.apiError") }}</span>
          <p class="error-text">{{ sessionsError }}</p>
          <button class="btn-secondary btn-sm" @click="loadSessions">{{ t("common.retry") }}</button>
        </div>

        <div v-else-if="!sessions.length" class="empty-state">
          <div class="empty-state-icon">◌</div>
          <div>{{ t("settings.sessions.empty") }}</div>
        </div>

        <div v-else class="table-wrap session-table" style="--grid-cols: 1fr 1.6fr 1fr 1fr auto">
          <div class="table-header">
            <span>{{ t("settings.sessions.colId") }}</span>
            <span>{{ t("settings.sessions.colUserAgent") }}</span>
            <span>{{ t("settings.sessions.colCreatedAt") }}</span>
            <span>{{ t("settings.sessions.colExpiresAt") }}</span>
            <span></span>
          </div>
          <div v-for="s in sessions" :key="s.id" class="table-row">
            <span class="session-id" :title="s.id">{{ s.id }}</span>
            <span class="session-ua" :title="s.userAgent">{{ s.userAgent }}</span>
            <span class="session-time">{{ formatTs(s.createdAt) }}</span>
            <span class="session-time">{{ formatTs(s.expiresAt) }}</span>
            <span><button class="btn-danger btn-sm" @click="revokeSession(s.id)">{{ t("settings.sessions.revoke") }}</button></span>
          </div>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ SUBSONIC CLIENTS ============ -->
    <section class="settings-section card" :class="{ open: open.clients }">
      <button class="section-header" @click="toggleSection('clients')">
        <span class="section-title">{{ t("settings.clients.title") }}</span>
        <span class="section-caret">{{ open.clients ? "−" : "+" }}</span>
      </button>

      <div v-show="open.clients" class="section-body">
        <p class="feature-desc section-desc">{{ t("settings.clients.desc") }}</p>

        <!-- Issue form -->
        <div class="cred-create">
          <input
            v-model="credLabel"
            class="form-input cred-label-input"
            :placeholder="t('settings.clients.labelPlaceholder')"
            @keydown.enter="createCredential"
          />
          <button class="btn-primary" :disabled="credBusy" @click="createCredential">{{ t("settings.clients.create") }}</button>
        </div>

        <!-- One-time reveal of the issued credential -->
        <div v-if="issued" class="issued-panel">
          <div class="issued-title">{{ t("settings.clients.createdTitle") }}</div>
          <div class="issued-row">
            <span class="mono-label">{{ t("settings.clients.server") }}</span>
            <code class="issued-value">{{ serverUrl }}</code>
            <button class="btn-secondary btn-sm" @click="copyText(serverUrl)">{{ t("common.copy") }}</button>
          </div>
          <div class="issued-row">
            <span class="mono-label">{{ t("settings.clients.username") }}</span>
            <code class="issued-value">{{ username }}</code>
            <button class="btn-secondary btn-sm" @click="copyText(username)">{{ t("common.copy") }}</button>
          </div>
          <div class="issued-row">
            <span class="mono-label">{{ t("settings.clients.password") }}</span>
            <code class="issued-value">{{ issued.password }}</code>
            <button class="btn-secondary btn-sm" @click="copyText(issued.password)">{{ t("common.copy") }}</button>
          </div>
        </div>

        <div v-if="credLoading" class="empty-state">{{ t("common.loading") }}</div>

        <div v-else-if="credError" class="error-panel">
          <span class="status-badge error">{{ t("settings.common.apiError") }}</span>
          <p class="error-text">{{ credError }}</p>
          <button class="btn-secondary btn-sm" @click="loadCredentials">{{ t("common.retry") }}</button>
        </div>

        <div v-else-if="!credentials.length" class="empty-state">
          <div class="empty-state-icon">◌</div>
          <div>{{ t("settings.clients.empty") }}</div>
        </div>

        <div v-else class="table-wrap session-table" style="--grid-cols: 1fr 1.4fr 1fr 1fr auto">
          <div class="table-header">
            <span>ID</span>
            <span>{{ t("settings.clients.colLabel") }}</span>
            <span>{{ t("settings.clients.colCreated") }}</span>
            <span>{{ t("settings.clients.colLastUsed") }}</span>
            <span></span>
          </div>
          <div v-for="cr in credentials" :key="cr.id" class="table-row">
            <span class="session-id" :title="cr.id">{{ cr.id }}</span>
            <span class="session-ua">{{ cr.label || "—" }}</span>
            <span class="session-time">{{ formatTs(cr.createdAt) }}</span>
            <span class="session-time">{{ cr.lastUsed ? formatTs(cr.lastUsed) : t("settings.clients.never") }}</span>
            <span><button class="btn-danger btn-sm" @click="deleteCredential(cr.id)">{{ t("common.delete") }}</button></span>
          </div>
        </div>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ PERMISSIONS ============ -->
    <section class="settings-section card" :class="{ open: open.permissions }">
      <button class="section-header" @click="toggleSection('permissions')">
        <span class="section-title">{{ t("settings.permissions.title") }}</span>
        <span class="section-side">
          <span class="status-badge warning">{{ t("settings.permissions.superOnly") }}</span>
          <span class="section-caret">{{ open.permissions ? "−" : "+" }}</span>
        </span>
      </button>

      <div v-show="open.permissions" class="section-body">
        <PermissionsMatrix />
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.settings { max-width: 1100px; }

/* --- Accordion sections --- */
.settings-section { padding: 0; margin-bottom: 1.1rem; overflow: hidden; }
.section-header {
  width: 100%;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.95rem 1.2rem;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background 0.15s;
}
.section-header:hover { background: var(--color-bg-tertiary); }
.settings-section.open .section-header { border-bottom: 1px solid var(--color-border-subtle); }
.section-title {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.section-caret {
  font-family: var(--font-mono);
  font-size: 1.1rem;
  color: var(--color-accent-primary);
  width: 20px; text-align: center;
}
.section-side { display: flex; align-items: center; gap: 0.7rem; }
.section-body { padding: 1.1rem 1.2rem 1.3rem; }
.section-desc { margin-bottom: 0.8rem; }

/* --- Sub blocks inside Common --- */
.sub-block { padding: 0.9rem 0; border-bottom: 1px solid var(--color-border-subtle); }
.sub-block:first-child { padding-top: 0; }
.sub-block:last-child { border-bottom: none; padding-bottom: 0; }
.sub-header { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.6rem; }

.instance-row { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; }
.instance-id {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  color: var(--color-accent-primary);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  padding: 0.3rem 0.7rem;
  letter-spacing: 0.05em;
  user-select: all;
}

.lang-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.lang-select { width: auto; min-width: 160px; }

.feature-list { display: flex; flex-direction: column; }
.feature-row {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.85rem 0.25rem;
  border-bottom: 1px solid var(--color-border-subtle);
}
.feature-row:last-child { border-bottom: none; }
.feature-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.feature-key {
  font-family: var(--font-mono);
  font-size: var(--fs-base);
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--color-text-primary);
}
.feature-desc { font-size: var(--fs-sm); color: var(--color-text-secondary); }

/* --- Sessions table --- */
.session-id, .session-ua {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}
.session-ua { color: var(--color-text-secondary); }
.session-time { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); white-space: nowrap; }

/* --- Subsonic clients --- */
.cred-create { display: flex; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
.cred-label-input { flex: 1; min-width: 220px; }
.issued-panel {
  border: 1px solid var(--color-accent-primary);
  background: var(--color-bg-primary);
  padding: 0.9rem 1rem;
  margin-bottom: 1rem;
  display: flex; flex-direction: column; gap: 0.55rem;
}
.issued-title {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-accent-primary);
}
.issued-row { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; }
.issued-row .mono-label { min-width: 80px; }
.issued-value {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  color: var(--color-text-primary);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
  padding: 0.25rem 0.6rem;
  user-select: all;
}

.error-panel { display: flex; flex-direction: column; align-items: flex-start; gap: 0.7rem; padding: 0.5rem 0; }
.error-text { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-secondary); }
</style>
