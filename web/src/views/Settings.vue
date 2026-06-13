<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";
import { setLocale, SUPPORTED_LOCALES, type AppLocale } from "../i18n";
import PermissionsMatrix from "../components/PermissionsMatrix.vue";
import { useWorkerPool } from "../stores/workerPool";

const router = useRouter();
const { t, locale } = useI18n();
const { isSuperAdmin, isAdmin, edgesonicFetch, edgesonicPost, logout, username } = useAuth();
// 052 — worker pool store. The Settings sub-block toggles participation and
// surfaces live stats; admin sees a queue overview pulled from /work/status.
const workerPool = useWorkerPool();

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
interface FeatureString { key: string; value: string; description: string; }
const features = ref<Feature[]>([]);
const featureStrings = ref<FeatureString[]>([]);
const instanceId = ref("");
const loading = ref(true);
const error = ref("");
const copied = ref(false);

// 049 — Transcode controls. The string-valued feature flags are pulled out of
// featureStrings into local refs so the form is plain HTML; saveTranscode()
// pushes them back via /rest/updateFeatureString.
const transcodeEngine = ref<"sandbox" | "external" | "disabled">("disabled");
const transcodeMode = ref<"on_demand" | "pre_bake" | "both">("on_demand");
const defaultProfiles = ref<string[]>([]);
const externalUrl = ref("");
const externalKeyInput = ref("");
const externalKeySet = ref(false);
const transcodeBusy = ref(false);
const PROFILE_OPTIONS: { id: string; label: string }[] = [
  { id: "mp3-128k", label: "MP3 128 kbps" },
  { id: "mp3-192k", label: "MP3 192 kbps" },
  { id: "aac-96k",  label: "AAC 96 kbps" },
  { id: "aac-128k", label: "AAC 128 kbps" },
  { id: "opus-64k", label: "Opus 64 kbps" },
  { id: "opus-96k", label: "Opus 96 kbps" },
  { id: "vorbis-96k", label: "Vorbis 96 kbps" },
  { id: "flac-lossless", label: "FLAC (lossless)" },
];

function findFeatureString(key: string, fallback: string): string {
  return featureStrings.value.find((f) => f.key === key)?.value ?? fallback;
}

async function loadFeatures() {
  loading.value = true;
  error.value = "";
  try {
    const text = await edgesonicFetch("features/list");
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "Request rejected");
    instanceId.value = data.instanceId || "";
    features.value = (data.features || []).map((f: Partial<Feature>) => ({
      key: f.key || "", value: Number(f.value) || 0, description: f.description || "",
    }));
    featureStrings.value = (data.featureStrings || []).map((f: Partial<FeatureString>) => ({
      key: f.key || "", value: typeof f.value === "string" ? f.value : "", description: f.description || "",
    }));
    // Hydrate transcode form from featureStrings.
    transcodeEngine.value = (findFeatureString("transcode_engine", "disabled") as "sandbox" | "external" | "disabled");
    transcodeMode.value = (findFeatureString("transcode_mode", "on_demand") as "on_demand" | "pre_bake" | "both");
    try {
      const parsed = JSON.parse(findFeatureString("default_transcode_profiles", "[]"));
      defaultProfiles.value = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    } catch { defaultProfiles.value = []; }
    externalUrl.value = findFeatureString("external_transcoder_url", "");
    // Probe the secret presence (the value itself never crosses the wire).
    try {
      const probe = JSON.parse(await edgesonicFetch("features/secrets/get"));
      externalKeySet.value = !!probe?.set;
    } catch { externalKeySet.value = false; }
    // 040: hydrate the scrape source priority list from feature_strings.
    hydrateScrapeFromFeatures();
    // 043: hydrate Last.fm key presence indicator.
    hydrateLastfmFromFeatures();
    // 051: hydrate WebDAV scan cadence + BROWSER READ controls.
    hydrateScanFromFeatures();
  } catch (e: unknown) {
    // 后端契约可能尚未部署 —— 优雅降级显示错误（非 JSON 响应一律视为 API 不可用）
    error.value = e instanceof SyntaxError || !(e instanceof Error)
      ? t("settings.common.apiUnavailable")
      : e.message;
    features.value = [];
    featureStrings.value = [];
  }
  loading.value = false;
}

function toggleProfile(id: string, checked: boolean) {
  if (checked && !defaultProfiles.value.includes(id)) defaultProfiles.value.push(id);
  else if (!checked) defaultProfiles.value = defaultProfiles.value.filter((p) => p !== id);
}

async function saveTranscode() {
  transcodeBusy.value = true;
  try {
    // updateFeatureString validates server-side; we batch four calls for one
    // user-visible "Save" click. Optimistic update — fail at the first error.
    const writes = [
      { key: "transcode_engine", value: transcodeEngine.value },
      { key: "transcode_mode", value: transcodeMode.value },
      { key: "default_transcode_profiles", value: JSON.stringify(defaultProfiles.value) },
      { key: "external_transcoder_url", value: externalUrl.value },
    ];
    for (const w of writes) {
      const data = JSON.parse(await edgesonicPost("features/updateString", w));
      if (!data.ok) throw new Error(data.error || w.key);
    }
    // External key is opaque — only POST when the input is non-empty.
    if (externalKeyInput.value) {
      const data = JSON.parse(await edgesonicPost("features/secrets/set", { value: externalKeyInput.value }));
      if (!data.ok) throw new Error(data.error || "external_key");
      externalKeySet.value = true;
      externalKeyInput.value = "";
    }
    showToast(t("settings.common.transcode.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.transcode.saveFailed")}: ${msg}`, "error");
  }
  transcodeBusy.value = false;
}

// === 040 — Metadata scrape sources ===
// scrape_enabled lives in the boolean `features` table; the priority list is
// in feature_strings.scrape_enabled_sources. Save batches both like transcode.
type ScrapeSourceKey = "netease" | "qmusic" | "kugou" | "kuwo" | "migu";
const SCRAPE_ALL_SOURCES: { id: ScrapeSourceKey; label: string }[] = [
  { id: "netease", label: "NetEase" },
  { id: "qmusic", label: "QQ Music" },
  { id: "kugou", label: "Kugou" },
  { id: "kuwo", label: "Kuwo (preview)" },
  { id: "migu", label: "Migu (preview)" },
];
const scrapeOrder = ref<ScrapeSourceKey[]>([]);
const scrapeEnabledSet = ref<Set<ScrapeSourceKey>>(new Set());
const scrapeBusy = ref(false);

function hydrateScrapeFromFeatures() {
  // Order = whatever the JSON array stored; we render it in that order and
  // any source NOT in the array gets appended (disabled) so the UI shows all.
  try {
    const raw = findFeatureString("scrape_enabled_sources", '["netease","qmusic","kugou"]');
    const parsed = JSON.parse(raw) as string[];
    const validEnabled: ScrapeSourceKey[] = [];
    const knownIds = new Set(SCRAPE_ALL_SOURCES.map((s) => s.id));
    for (const s of parsed) {
      if (knownIds.has(s as ScrapeSourceKey)) validEnabled.push(s as ScrapeSourceKey);
    }
    scrapeEnabledSet.value = new Set(validEnabled);
    const orderTail = SCRAPE_ALL_SOURCES
      .map((s) => s.id)
      .filter((id) => !validEnabled.includes(id));
    scrapeOrder.value = [...validEnabled, ...orderTail];
  } catch {
    scrapeOrder.value = SCRAPE_ALL_SOURCES.map((s) => s.id);
    scrapeEnabledSet.value = new Set(["netease", "qmusic", "kugou"]);
  }
}

function toggleScrapeSource(id: ScrapeSourceKey, checked: boolean) {
  const next = new Set(scrapeEnabledSet.value);
  if (checked) next.add(id); else next.delete(id);
  scrapeEnabledSet.value = next;
}

function moveScrapeSource(id: ScrapeSourceKey, delta: -1 | 1) {
  const arr = [...scrapeOrder.value];
  const i = arr.indexOf(id);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  scrapeOrder.value = arr;
}

async function saveScrape() {
  scrapeBusy.value = true;
  try {
    // Persist only the enabled subset in the user-chosen priority order.
    const enabledInOrder = scrapeOrder.value.filter((id) => scrapeEnabledSet.value.has(id));
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "scrape_enabled_sources",
      value: JSON.stringify(enabledInOrder),
    }));
    if (!data.ok) throw new Error(data.error || "scrape_enabled_sources");
    showToast(t("settings.common.scrape.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.scrape.saveFailed")}: ${msg}`, "error");
  }
  scrapeBusy.value = false;
}

// === 043 — Last.fm API key ===
// Stored in feature_strings.lastfm_api_key. Empty means the four getXxxInfo
// proxies stay quiet (Subsonic error code 30 to clients).
const lastfmKeyInput = ref("");
const lastfmKeySet = ref(false);
const lastfmBusy = ref(false);

function hydrateLastfmFromFeatures() {
  const stored = findFeatureString("lastfm_api_key", "");
  lastfmKeySet.value = !!stored;
  // We never put the actual key back in the input — keeps it from being
  // accidentally re-saved or copied out of the DOM by a curious client.
  lastfmKeyInput.value = "";
}

async function saveLastfm() {
  lastfmBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "lastfm_api_key",
      value: lastfmKeyInput.value,
    }));
    if (!data.ok) throw new Error(data.error || "lastfm_api_key");
    lastfmKeySet.value = !!lastfmKeyInput.value;
    lastfmKeyInput.value = "";
    showToast(t("settings.common.lastfm.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  lastfmBusy.value = false;
}

// === 051 — Scan settings ===
// Four feature_strings drive the incremental WebDAV scanner + BROWSER READ
// queue. Stored as strings so the same updateFeatureString endpoint works.
const scanIntervalHours = ref<number>(1);
const scanEtagCheck = ref<boolean>(true);
const scanRescanStrategy = ref<"auto" | "worker" | "browser">("auto");
const scanBrowserAuto = ref<boolean>(true);
const scanBusy = ref(false);

function hydrateScanFromFeatures() {
  const hours = parseInt(findFeatureString("scan_interval_hours", "1"), 10);
  scanIntervalHours.value = Number.isFinite(hours) && hours >= 0 ? hours : 1;
  scanEtagCheck.value = findFeatureString("scan_etag_check", "1") !== "0";
  const strat = findFeatureString("scan_rescan_strategy", "auto");
  scanRescanStrategy.value = (["auto", "worker", "browser"].includes(strat)
    ? strat
    : "auto") as "auto" | "worker" | "browser";
  scanBrowserAuto.value = findFeatureString("scan_browser_auto", "1") !== "0";
}

async function saveScan() {
  scanBusy.value = true;
  try {
    // Clamp hours just in case the input slips past the min/max — the worker
    // also validates but a friendly client-side guard avoids a round-trip.
    const hours = Math.max(0, Math.min(168, Math.floor(scanIntervalHours.value || 0)));
    scanIntervalHours.value = hours;
    const writes = [
      { key: "scan_interval_hours", value: String(hours) },
      { key: "scan_etag_check", value: scanEtagCheck.value ? "1" : "0" },
      { key: "scan_rescan_strategy", value: scanRescanStrategy.value },
      { key: "scan_browser_auto", value: scanBrowserAuto.value ? "1" : "0" },
    ];
    for (const w of writes) {
      const data = JSON.parse(await edgesonicPost("features/updateString", w));
      if (!data.ok) throw new Error(data.error || w.key);
    }
    showToast(t("settings.common.scan.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.scan.saveFailed")}: ${msg}`, "error");
  }
  scanBusy.value = false;
}

// === 052 — Worker pool ===
// The local participate switch is the only writable control for non-admins.
// Admins additionally see the per-status counts and per-user active load.
const workerStatus = ref<{
  counts: Record<string, number>;
  load: Array<{ username: string; n: number }>;
  recent: Array<{
    id: string;
    task_type: string;
    status: string;
    claimed_by: string | null;
    attempts: number;
    max_attempts: number;
  }>;
} | null>(null);
const workerStatusLoading = ref(false);
const workerStatusError = ref("");

const workerPollIntervalText = computed(() => {
  const ms = workerPool.pollIntervalMs;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
});

async function loadWorkerStatus() {
  if (!isSuperAdmin.value) return;
  workerStatusLoading.value = true;
  workerStatusError.value = "";
  try {
    const text = await edgesonicFetch("work/status");
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    workerStatus.value = {
      counts: data.counts || {},
      load: data.load || [],
      recent: data.recent || [],
    };
  } catch (e: unknown) {
    workerStatusError.value = e instanceof Error ? e.message : String(e);
  }
  workerStatusLoading.value = false;
}

async function onParticipateToggle(checked: boolean) {
  workerPool.setEnabled(checked);
}

async function onPollNow() {
  await workerPool.pollNow();
  // If we're admin reload the status so the just-completed/failed task
  // count moves in the table without a manual refresh.
  if (isSuperAdmin.value) await loadWorkerStatus();
}

async function clearLastfm() {
  lastfmBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "lastfm_api_key",
      value: "",
    }));
    if (!data.ok) throw new Error(data.error || "lastfm_api_key");
    lastfmKeySet.value = false;
    lastfmKeyInput.value = "";
    showToast(t("settings.common.lastfm.cleared"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.lastfm.saveFailed")}: ${msg}`, "error");
  }
  lastfmBusy.value = false;
}

async function toggleFeature(f: Feature, checked: boolean) {
  const newValue = checked ? 1 : 0;
  const oldValue = f.value;
  f.value = newValue; // optimistic
  try {
    const text = await edgesonicPost("features/update", { key: f.key, value: newValue });
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
    const xml = await edgesonicFetch("auth/sessions/list");
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
    const xml = await edgesonicPost("auth/sessions/revoke", { id });
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
    const xml = await edgesonicFetch("auth/credentials/list");
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
    const xml = await edgesonicPost("auth/credentials/create", { password, label });
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
    const xml = await edgesonicPost("auth/credentials/delete", { id });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    if (issued.value) issued.value = null;
    await loadCredentials();
  } catch { showToast(t("settings.clients.loadFailed"), "error"); }
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); showToast(t("common.copied")); }
  catch { showToast(t("settings.common.copyFailed"), "error"); }
}

onMounted(() => {
  loadFeatures();
  loadSessions();
  loadCredentials();
  // 052 — only super-admin sees the queue overview block; load it on mount.
  if (isSuperAdmin.value) loadWorkerStatus();
});
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

        <!-- 049 — Transcode controls -->
        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.transcode.title") }}</span>
          </div>
          <div class="transcode-grid">
            <!-- Engine -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.transcode.engine") }}</span>
              <select v-model="transcodeEngine" class="form-select" :disabled="!isSuperAdmin">
                <option value="disabled">{{ t("settings.common.transcode.engineDisabled") }}</option>
                <option value="sandbox">{{ t("settings.common.transcode.engineSandbox") }}</option>
                <option value="external">{{ t("settings.common.transcode.engineExternal") }}</option>
              </select>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.transcode.engineDesc") }}</p>

            <!-- Mode -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.transcode.mode") }}</span>
              <select v-model="transcodeMode" class="form-select" :disabled="!isSuperAdmin">
                <option value="on_demand">{{ t("settings.common.transcode.modeOnDemand") }}</option>
                <option value="pre_bake">{{ t("settings.common.transcode.modePreBake") }}</option>
                <option value="both">{{ t("settings.common.transcode.modeBoth") }}</option>
              </select>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.transcode.modeDesc") }}</p>

            <!-- Default profiles (multi) -->
            <div class="tc-row tc-row-block">
              <span class="tc-key">{{ t("settings.common.transcode.profiles") }}</span>
              <div class="tc-profiles">
                <label v-for="p in PROFILE_OPTIONS" :key="p.id" class="tc-profile-pill">
                  <input
                    type="checkbox"
                    :checked="defaultProfiles.includes(p.id)"
                    :disabled="!isSuperAdmin"
                    @change="toggleProfile(p.id, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ p.label }}</span>
                </label>
              </div>
            </div>
            <p class="feature-desc tc-desc">{{ t("settings.common.transcode.profilesDesc") }}</p>

            <!-- External URL -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.transcode.externalUrl") }}</span>
              <input
                v-model="externalUrl"
                class="form-input"
                :placeholder="t('settings.common.transcode.externalUrlPlaceholder')"
                :disabled="!isSuperAdmin"
              />
            </label>

            <!-- External key -->
            <label class="tc-row">
              <span class="tc-key">
                {{ t("settings.common.transcode.externalKey") }}
                <span class="status-badge" :class="externalKeySet ? 'success' : 'muted'">
                  {{ externalKeySet ? t("settings.common.transcode.externalKeySet") : t("settings.common.transcode.externalKeyUnset") }}
                </span>
              </span>
              <input
                v-model="externalKeyInput"
                type="password"
                class="form-input"
                :placeholder="t('settings.common.transcode.externalKeyPlaceholder')"
                :disabled="!isSuperAdmin"
              />
            </label>

            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!isSuperAdmin || transcodeBusy"
                @click="saveTranscode"
              >
                {{ t("settings.common.transcode.save") }}
              </button>
            </div>
          </div>
        </div>

        <!-- 040 — Metadata scrape sources -->
        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.scrape.title") }}</span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.scrape.desc") }}
          </p>
          <div class="scrape-source-list">
            <div v-for="(id, idx) in scrapeOrder" :key="id" class="scrape-source-row">
              <label class="scrape-source-toggle">
                <input
                  type="checkbox"
                  :checked="scrapeEnabledSet.has(id)"
                  :disabled="!isSuperAdmin"
                  @change="toggleScrapeSource(id, ($event.target as HTMLInputElement).checked)"
                />
                <span class="scrape-source-label">
                  {{ SCRAPE_ALL_SOURCES.find((s) => s.id === id)?.label || id }}
                </span>
              </label>
              <div class="scrape-source-rank">
                <span class="rank-num">{{ idx + 1 }}</span>
                <button
                  class="rank-btn"
                  :disabled="!isSuperAdmin || idx === 0"
                  :title="t('settings.common.scrape.moveUp')"
                  @click="moveScrapeSource(id, -1)"
                >▲</button>
                <button
                  class="rank-btn"
                  :disabled="!isSuperAdmin || idx === scrapeOrder.length - 1"
                  :title="t('settings.common.scrape.moveDown')"
                  @click="moveScrapeSource(id, 1)"
                >▼</button>
              </div>
            </div>
          </div>
          <div class="tc-actions">
            <button
              class="btn-primary"
              :disabled="!isSuperAdmin || scrapeBusy"
              @click="saveScrape"
            >
              {{ t("settings.common.scrape.save") }}
            </button>
          </div>
        </div>

        <!-- 043 — Last.fm API key -->
        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.lastfm.title") }}</span>
            <span class="status-badge" :class="lastfmKeySet ? 'success' : 'muted'">
              {{ lastfmKeySet ? t("settings.common.lastfm.setStatus") : t("settings.common.lastfm.unsetStatus") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.lastfm.desc") }}
          </p>
          <label class="tc-row">
            <span class="tc-key">{{ t("settings.common.lastfm.label") }}</span>
            <input
              v-model="lastfmKeyInput"
              type="password"
              class="form-input"
              :placeholder="t('settings.common.lastfm.placeholder')"
              :disabled="!isSuperAdmin"
              autocomplete="off"
            />
          </label>
          <div class="tc-actions">
            <button
              v-if="lastfmKeySet"
              class="btn-secondary"
              :disabled="!isSuperAdmin || lastfmBusy"
              @click="clearLastfm"
              style="margin-right: 0.6rem"
            >
              {{ t("settings.common.lastfm.clear") }}
            </button>
            <button
              class="btn-primary"
              :disabled="!isSuperAdmin || lastfmBusy || !lastfmKeyInput"
              @click="saveLastfm"
            >
              {{ t("settings.common.lastfm.save") }}
            </button>
          </div>
        </div>

        <!-- 051 — Scan settings -->
        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.scan.title") }}</span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.scan.desc") }}
          </p>
          <div class="transcode-grid">
            <!-- Interval -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.scan.intervalHours") }}</span>
              <input
                v-model.number="scanIntervalHours"
                type="number"
                min="0"
                max="168"
                step="1"
                class="form-input"
                :disabled="!isSuperAdmin"
              />
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.scan.intervalHoursDesc") }}</p>

            <!-- ETag check -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.scan.etagCheck") }}</span>
              <span class="scan-toggle">
                <input
                  type="checkbox"
                  v-model="scanEtagCheck"
                  :disabled="!isSuperAdmin"
                />
                <span>{{ scanEtagCheck ? t("common.on") : t("common.off") }}</span>
              </span>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.scan.etagCheckDesc") }}</p>

            <!-- Rescan strategy -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.scan.strategy") }}</span>
              <select v-model="scanRescanStrategy" class="form-select" :disabled="!isSuperAdmin">
                <option value="auto">{{ t("settings.common.scan.strategyAuto") }}</option>
                <option value="worker">{{ t("settings.common.scan.strategyWorker") }}</option>
                <option value="browser">{{ t("settings.common.scan.strategyBrowser") }}</option>
              </select>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.scan.strategyDesc") }}</p>

            <!-- Browser auto-drain -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.scan.browserAuto") }}</span>
              <span class="scan-toggle">
                <input
                  type="checkbox"
                  v-model="scanBrowserAuto"
                  :disabled="!isSuperAdmin"
                />
                <span>{{ scanBrowserAuto ? t("common.on") : t("common.off") }}</span>
              </span>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.scan.browserAutoDesc") }}</p>

            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!isSuperAdmin || scanBusy"
                @click="saveScan"
              >
                {{ t("settings.common.scan.save") }}
              </button>
            </div>
          </div>
        </div>

        <!-- 052 — Worker pool -->
        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.workerPool.title") }}</span>
            <span class="status-badge" :class="workerPool.eligible ? (workerPool.enabled ? 'success' : 'muted') : 'warning'">
              {{ workerPool.eligible ? (workerPool.enabled ? t("common.on") : t("common.off")) : t("common.off") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.workerPool.desc") }}
          </p>

          <p v-if="!workerPool.eligible" class="feature-desc tc-desc" style="margin-left:0; color: var(--color-accent-primary)">
            {{ t("settings.common.workerPool.ineligible") }}
          </p>

          <div class="transcode-grid">
            <!-- Participate toggle -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.workerPool.participate") }}</span>
              <span class="scan-toggle">
                <input
                  type="checkbox"
                  :checked="workerPool.enabled"
                  :disabled="!workerPool.eligible"
                  @change="onParticipateToggle(($event.target as HTMLInputElement).checked)"
                />
                <span>{{ workerPool.enabled ? t("common.on") : t("common.off") }}</span>
              </span>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.workerPool.participateDesc") }}</p>

            <!-- Capabilities -->
            <div class="tc-row tc-row-block">
              <span class="tc-key">{{ t("settings.common.workerPool.capsLabel") }}</span>
              <div class="tc-profiles">
                <span v-for="cap in workerPool.caps" :key="cap" class="tc-profile-pill">
                  <span>{{ cap }}</span>
                </span>
                <span v-if="workerPool.caps.length === 0" class="feature-desc">—</span>
              </div>
            </div>

            <!-- Stats -->
            <div class="tc-row">
              <span class="tc-key">{{ t("settings.common.workerPool.statsLabel") }}</span>
              <span class="worker-stats">
                <span class="worker-stat worker-stat-success">
                  {{ t("settings.common.workerPool.statsCompleted") }}: {{ workerPool.stats.completed }}
                </span>
                <span class="worker-stat worker-stat-error">
                  {{ t("settings.common.workerPool.statsFailed") }}: {{ workerPool.stats.failed }}
                </span>
              </span>
            </div>

            <!-- Status -->
            <div class="tc-row">
              <span class="tc-key">{{ t("settings.common.workerPool.statusLabel") }}</span>
              <span class="feature-desc">
                {{ workerPool.stats.currentTaskType
                  ? t("settings.common.workerPool.statusRunning", { type: workerPool.stats.currentTaskType })
                  : t("settings.common.workerPool.statusIdle") }}
              </span>
            </div>

            <!-- Poll interval (read-only display) -->
            <div class="tc-row">
              <span class="tc-key">{{ t("settings.common.workerPool.pollIntervalLabel") }}</span>
              <span class="feature-desc">{{ workerPollIntervalText }}</span>
            </div>

            <!-- Last error -->
            <div v-if="workerPool.lastError" class="tc-row">
              <span class="tc-key">{{ t("settings.common.workerPool.lastError") }}</span>
              <code class="feature-desc" style="color: var(--color-accent-primary)">{{ workerPool.lastError }}</code>
            </div>

            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="!workerPool.eligible || !workerPool.enabled"
                @click="onPollNow"
              >
                {{ t("settings.common.workerPool.pollNow") }}
              </button>
            </div>
          </div>

          <!-- Admin queue overview -->
          <div v-if="isSuperAdmin" class="worker-queue-overview">
            <div class="sub-header" style="margin-top: 0.6rem">
              <span class="mono-label">{{ t("settings.common.workerPool.queueOverview") }}</span>
              <button class="btn-secondary btn-sm" :disabled="workerStatusLoading" @click="loadWorkerStatus">
                {{ workerStatusLoading ? t("settings.common.workerPool.refreshing") : t("settings.common.workerPool.refreshStatus") }}
              </button>
            </div>
            <div v-if="workerStatusError" class="error-panel">
              <code class="error-text">{{ workerStatusError }}</code>
            </div>
            <div v-else-if="workerStatus" class="worker-counts-row">
              <span class="worker-count worker-count-queued">{{ t("settings.common.workerPool.queueQueued") }}: {{ workerStatus.counts.queued || 0 }}</span>
              <span class="worker-count worker-count-claimed">{{ t("settings.common.workerPool.queueClaimed") }}: {{ workerStatus.counts.claimed || 0 }}</span>
              <span class="worker-count worker-count-completed">{{ t("settings.common.workerPool.queueCompleted") }}: {{ workerStatus.counts.completed || 0 }}</span>
              <span class="worker-count worker-count-failed">{{ t("settings.common.workerPool.queueFailed") }}: {{ workerStatus.counts.failed || 0 }}</span>
              <span class="worker-count worker-count-canceled">{{ t("settings.common.workerPool.queueCanceled") }}: {{ workerStatus.counts.canceled || 0 }}</span>
            </div>
            <div v-if="workerStatus" class="worker-load-row">
              <span class="mono-label">{{ t("settings.common.workerPool.queueLoad") }}</span>
              <span v-if="workerStatus.load.length === 0" class="feature-desc">{{ t("settings.common.workerPool.noLoad") }}</span>
              <span v-for="l in workerStatus.load" :key="l.username" class="tc-profile-pill">
                {{ t("settings.common.workerPool.loadEntry", { user: l.username, n: l.n }) }}
              </span>
            </div>
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

/* --- 049 Transcode controls --- */
.transcode-grid { display: flex; flex-direction: column; gap: 0.65rem; }
.tc-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.tc-row-block { align-items: flex-start; }
.tc-key {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--color-text-primary);
  min-width: 180px;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.tc-row .form-select,
.tc-row .form-input { flex: 1; min-width: 220px; }
.tc-desc { margin-left: 180px; }
.tc-profiles { display: flex; flex-wrap: wrap; gap: 0.5rem; flex: 1; min-width: 0; }
.tc-profile-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  cursor: pointer;
  user-select: none;
}
.tc-profile-pill input { margin: 0; }
.tc-actions { margin-top: 0.4rem; display: flex; justify-content: flex-end; }

/* --- 051 Scan toggle pill --- */
.scan-toggle {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
}
.scan-toggle input { margin: 0; }

/* --- 052 Worker pool --- */
.worker-stats { display: inline-flex; gap: 0.8rem; flex-wrap: wrap; }
.worker-stat {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.04em;
}
.worker-stat-success { color: var(--color-text-primary); }
.worker-stat-error { color: var(--color-accent-primary); }
.worker-queue-overview { margin-top: 0.8rem; border-top: 1px dashed var(--color-border-subtle); padding-top: 0.7rem; }
.worker-counts-row { display: flex; flex-wrap: wrap; gap: 0.6rem; padding: 0.4rem 0; }
.worker-count {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  padding: 0.2rem 0.6rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  letter-spacing: 0.05em;
}
.worker-count-failed, .worker-count-canceled { color: var(--color-accent-primary); }
.worker-load-row {
  display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
  padding-top: 0.4rem;
}

/* --- 040 Scrape source list --- */
.scrape-source-list { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.6rem; }
.scrape-source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.4rem 0.6rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
}
.scrape-source-toggle { display: inline-flex; align-items: center; gap: 0.55rem; cursor: pointer; }
.scrape-source-label {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.05em;
  color: var(--color-text-primary);
}
.scrape-source-rank { display: inline-flex; align-items: center; gap: 0.4rem; }
.rank-num {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  min-width: 1.5rem;
  text-align: right;
}
.rank-btn {
  width: 24px; height: 24px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border-subtle);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.rank-btn:hover:not(:disabled) { color: var(--color-accent-primary); background: var(--color-bg-primary); }
.rank-btn:disabled { opacity: 0.35; cursor: not-allowed; }
</style>
