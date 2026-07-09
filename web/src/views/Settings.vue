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
const { isSuperAdmin, isAdmin, edgesonicFetch, edgesonicPost, logout, username, handleAuthError } = useAuth();
// 052 — worker pool store. The Settings sub-block toggles participation and
// surfaces live stats; admin sees a queue overview pulled from /work/status.
const workerPool = useWorkerPool();

// === Accordion ===
type SectionKey = "user" | "system" | "sessions" | "clients" | "permissions";
const open = ref<Record<SectionKey, boolean>>({ user: true, system: false, sessions: false, clients: false, permissions: false });
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
const transcodeEngine = ref<"sandbox" | "external" | "browser_pool" | "disabled">("disabled");
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
    transcodeEngine.value = (findFeatureString("transcode_engine", "disabled") as "sandbox" | "external" | "browser_pool" | "disabled");
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
    void hydrateLastfmFromUserSetting();
    // 051: hydrate WebDAV scan cadence + BROWSER READ controls.
    hydrateScanFromFeatures();
    // 065: hydrate cross-origin isolation toggle.
    hydrateCioFromFeatures();
    // 091/092: hydrate presign toggles + probe R2 secrets presence.
    hydratePresignFromFeatures();
    loadR2PresignStatus();
    // 110: hydrate the metadata re-check cadence.
    hydrateMetadataRecheckFromFeatures();
    // 113: hydrate the LRC sidecar backfill cadence.
    hydrateLrcBackfillFromFeatures();
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

// === 043/110 — Last.fm API key (per-user setting) ===
// Stored in user_settings.lastfm_api_key (per-user, not system-level).
// Empty means the four getXxxInfo proxies stay quiet (Subsonic error code 30).
const lastfmKeyInput = ref("");
const lastfmKeySet = ref(false);
const lastfmBusy = ref(false);

async function hydrateLastfmFromUserSetting() {
  try {
    const data = JSON.parse(await edgesonicFetch("features/userSetting?key=lastfm_api_key"));
    if (data.ok) lastfmKeySet.value = !!data.set;
  } catch { /* stay false */ }
  lastfmKeyInput.value = "";
}

async function saveLastfm() {
  lastfmBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/userSetting", {
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

// === 065 — Cross-Origin Isolation ===
// COOP/COEP/CORP gating for SharedArrayBuffer + ffmpeg.wasm multi-thread.
// `crossOriginIsolated` reflects the *current* page state (live), not the
// feature flag — so the admin can see whether their last change took effect
// after a reload.
const cioEnabled = ref<boolean>(true);
const cioBusy = ref(false);
const cioLive = computed<boolean>(() =>
  typeof window !== "undefined" &&
  (window as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
);

function hydrateCioFromFeatures() {
  cioEnabled.value = findFeatureString("enable_cross_origin_isolation", "1") !== "0";
}

async function saveCio() {
  cioBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "enable_cross_origin_isolation",
      value: cioEnabled.value ? "1" : "0",
    }));
    if (!data.ok) throw new Error(data.error || "enable_cross_origin_isolation");
    showToast(t("settings.common.crossOriginIsolation.saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.crossOriginIsolation.saveFailed")}: ${msg}`, "error");
  }
  cioBusy.value = false;
}

// === 091/092 — R2 + WebDAV presigned URL direct stream ===
// Two feature flags + the R2 S3 secrets presence. The Dashboard surfaces a
// "stream speed may be limited" hint when presign is inactive; this sub-block
// is the admin-facing toggle + status readout.
const r2PresignEnabled = ref<boolean>(false);
const webdavPresignEnabled = ref<boolean>(true);
const r2SecretsConfigured = ref<boolean>(false);
const r2PresignBusy = ref(false);
const webdavPresignBusy = ref(false);

function hydratePresignFromFeatures() {
  r2PresignEnabled.value = findFeatureString("enable_r2_presign", "0") === "1";
  webdavPresignEnabled.value = findFeatureString("enable_webdav_presign", "1") === "1";
}

async function loadR2PresignStatus() {
  if (!isSuperAdmin.value) return;
  try {
    const data = JSON.parse(await edgesonicFetch("r2presign/status"));
    if (data?.ok) r2SecretsConfigured.value = !!data.secretsConfigured;
  } catch { /* status endpoint may be absent on older deploys — silent */ }
}

async function saveR2Presign() {
  r2PresignBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "enable_r2_presign",
      value: r2PresignEnabled.value ? "1" : "0",
    }));
    if (!data.ok) throw new Error(data.error || "enable_r2_presign");
    showToast(t("settings.common.presign.r2Saved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.presign.saveFailed")}: ${msg}`, "error");
  }
  r2PresignBusy.value = false;
}

async function saveWebdavPresign() {
  webdavPresignBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "enable_webdav_presign",
      value: webdavPresignEnabled.value ? "1" : "0",
    }));
    if (!data.ok) throw new Error(data.error || "enable_webdav_presign");
    showToast(t("settings.common.presign.webdavSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.presign.saveFailed")}: ${msg}`, "error");
  }
  webdavPresignBusy.value = false;
}

// === 110 — metadata re-check cadence ===
const metadataRecheckIntervalHours = ref<number>(24);
const metadataRecheckIntervalBusy = ref(false);

function hydrateMetadataRecheckFromFeatures() {
  const hours = parseInt(findFeatureString("metadata_recheck_interval_hours", "24"), 10);
  metadataRecheckIntervalHours.value = Number.isFinite(hours) && hours >= 0 ? hours : 24;
}

async function saveMetadataRecheckInterval() {
  metadataRecheckIntervalBusy.value = true;
  try {
    const hours = Math.max(0, Math.min(168, Math.floor(metadataRecheckIntervalHours.value || 0)));
    metadataRecheckIntervalHours.value = hours;
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "metadata_recheck_interval_hours",
      value: String(hours),
    }));
    if (!data.ok) throw new Error(data.error || "metadata_recheck_interval_hours");
    showToast(t("settings.common.workerPool.recheckIntervalSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.workerPool.recheckIntervalSaveFailed")}: ${msg}`, "error");
  }
  metadataRecheckIntervalBusy.value = false;
}

// === 113 — LRC sidecar backfill cadence ===
const lrcBackfillIntervalHours = ref<number>(24);
const lrcBackfillIntervalBusy = ref(false);

function hydrateLrcBackfillFromFeatures() {
  const hours = parseInt(findFeatureString("lrc_backfill_interval_hours", "24"), 10);
  lrcBackfillIntervalHours.value = Number.isFinite(hours) && hours >= 0 ? hours : 24;
}

async function saveLrcBackfillInterval() {
  lrcBackfillIntervalBusy.value = true;
  try {
    const hours = Math.max(0, Math.min(168, Math.floor(lrcBackfillIntervalHours.value || 0)));
    lrcBackfillIntervalHours.value = hours;
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "lrc_backfill_interval_hours",
      value: String(hours),
    }));
    if (!data.ok) throw new Error(data.error || "lrc_backfill_interval_hours");
    showToast(t("settings.common.workerPool.lrcBackfillIntervalSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.workerPool.lrcBackfillIntervalSaveFailed")}: ${msg}`, "error");
  }
  lrcBackfillIntervalBusy.value = false;
}

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

// === 054 — Cloudflare integration ===
// Six endpoints under /edgesonic/cf/*. Token never echoed; UI shows tokenLast4
// so the admin can recognise which token is live. All controls hidden when
// the user is not super-admin (level<3).
interface CfStatus {
  configured: boolean;
  accountId: string;
  tokenLast4: string;
}
interface CfAnalytics {
  available: boolean;
  requests?: number;
  errors?: number;
  errorRate?: number;
  cpuMs?: number;
  cpuP99Ms?: number;
  error?: string;
}
const cfStatus = ref<CfStatus>({ configured: false, accountId: "", tokenLast4: "" });
const cfAccountId = ref("");
const cfToken = ref("");
const cfBusy = ref(false);
const cfTestBusy = ref(false);
const cronExpression = ref("");
const cronBusy = ref(false);
const cfAnalytics = ref<CfAnalytics | null>(null);
const cfAnalyticsBusy = ref(false);
// 067 — Post-deploy "restore default cron" trigger. wrangler deploy clears
// the Worker's schedules; this button re-applies "0 */1 * * *" when the
// schedules list is empty (no-op when admin already wrote a custom cadence).
const cfEnsureCronBusy = ref(false);

async function loadCfStatus() {
  if (!isSuperAdmin.value) return;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/getStatus")) as CfStatus & { ok: boolean };
    if (data.ok) {
      cfStatus.value = { configured: data.configured, accountId: data.accountId, tokenLast4: data.tokenLast4 };
      // Pre-fill the account ID input when one is on file so re-saving the
      // token doesn't require typing the account ID again.
      if (data.accountId && !cfAccountId.value) cfAccountId.value = data.accountId;
    }
  } catch { /* status is best-effort */ }
}

async function loadCfCron() {
  if (!isSuperAdmin.value) return;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/getCron")) as {
      ok: boolean;
      schedules?: Array<{ cron: string }>;
    };
    if (data.ok && Array.isArray(data.schedules)) {
      cronExpression.value = data.schedules.map((s) => s.cron).join("\n");
    }
  } catch { /* cron load failure is silent — the user can still type */ }
}

async function saveCfToken() {
  if (!cfToken.value.trim() || !cfAccountId.value.trim()) {
    showToast(t("settings.common.cf.saveFailed"), "error");
    return;
  }
  cfBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("cf/setToken", {
      accountId: cfAccountId.value.trim(),
      token: cfToken.value.trim(),
    })) as { ok: boolean; error?: string; tokenLast4?: string };
    if (!data.ok) throw new Error(data.error || "setToken");
    cfToken.value = "";
    showToast(t("settings.common.cf.saved"));
    // Wait a beat so env can refresh — getStatus reads from env, so we
    // immediately follow up to surface the new tokenLast4.
    await loadCfStatus();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.cf.saveFailed")}: ${msg}`, "error");
  }
  cfBusy.value = false;
}

async function testCfConn() {
  cfTestBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/testConn")) as {
      ok: boolean;
      error?: string;
      accountName?: string;
    };
    if (!data.ok) throw new Error(data.error || "testConn");
    showToast(t("settings.common.cf.testOk", { name: data.accountName || cfStatus.value.accountId }));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.cf.testFailed")}: ${msg}`, "error");
  }
  cfTestBusy.value = false;
}

async function saveCron() {
  cronBusy.value = true;
  try {
    const crons = cronExpression.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const data = JSON.parse(await edgesonicPost("cf/setCron", { crons })) as {
      ok: boolean;
      error?: string;
    };
    if (!data.ok) throw new Error(data.error || "setCron");
    showToast(t("settings.common.cf.cronSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.cf.cronSaveFailed")}: ${msg}`, "error");
  }
  cronBusy.value = false;
}

// 067 — Restore the default Worker schedule after a wrangler deploy.
// Behaviour:
//   - applied=true  → CF schedules were empty, default re-applied; toast OK
//   - applied=false → schedules already populated, no change; informational toast
//   - error path    → surface the CF error verbatim
async function ensureDefaultCron() {
  cfEnsureCronBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/ensureDefaultCron")) as {
      ok: boolean;
      error?: string;
      applied?: boolean;
      schedules?: Array<{ cron: string }> | unknown;
    };
    if (!data.ok) throw new Error(data.error || "ensureDefaultCron");
    if (data.applied) {
      showToast(t("settings.common.cf.ensureCronApplied"));
      // Reflect the new cron in the editable textarea so the admin sees what's live.
      await loadCfCron();
    } else {
      showToast(t("settings.common.cf.ensureCronAlreadySet"));
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.cf.ensureCronFailed")}: ${msg}`, "error");
  }
  cfEnsureCronBusy.value = false;
}

async function loadCfAnalytics() {
  if (!isSuperAdmin.value) return;
  cfAnalyticsBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicFetch("cf/getAnalytics")) as CfAnalytics & { ok: boolean };
    cfAnalytics.value = data;
  } catch (e: unknown) {
    cfAnalytics.value = {
      available: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  cfAnalyticsBusy.value = false;
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
    if (handleAuthError(e)) {
      showToast(t("common.sessionExpired"), "error");
      workerStatusError.value = t("common.sessionExpired");
      return;
    }
    workerStatusError.value = e instanceof Error ? e.message : String(e);
  }
  workerStatusLoading.value = false;
}

async function onParticipateToggle(checked: boolean) {
  workerPool.setEnabled(checked);
}

// 088 — concurrent Web Worker count. The input mirrors workerPool.maxConcurrent
// so the field shows the currently-live value on mount (and after a feature
// reload) without an extra round-trip. saveMaxConcurrent() POSTs to
// /features/updateString and rehydrates the store so future polls use the new
// `limit` immediately.
const maxConcurrentInput = ref<number>(workerPool.maxConcurrent);
const maxConcurrentBusy = ref(false);
async function saveMaxConcurrent() {
  const n = Math.max(1, Math.min(8, Math.floor(Number(maxConcurrentInput.value) || 0)));
  maxConcurrentInput.value = n;
  maxConcurrentBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/updateString", {
      key: "worker_max_concurrent",
      value: String(n),
    }));
    if (!data.ok) throw new Error(data.error || "worker_max_concurrent");
    await workerPool.hydrateConfig();
    // Re-sync the input in case hydrate clamped to a different value (e.g.
    // server rejected and store stayed at the previous setting).
    maxConcurrentInput.value = workerPool.maxConcurrent;
    showToast(t("settings.common.workerPool.maxConcurrentSaved"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("settings.common.workerPool.maxConcurrentSaveFailed")}: ${msg}`, "error");
  }
  maxConcurrentBusy.value = false;
}

async function onPollNow() {
  await workerPool.pollNow();
  // If we're admin reload the status so the just-completed/failed task
  // count moves in the table without a manual refresh.
  if (isSuperAdmin.value) await loadWorkerStatus();
}

// 077 — admin trigger for /edgesonic/work/backfillCompleted. Replays
// applyMetadataResult against every completed metadata row whose apply step
// was skipped before 077 landed (~82 rows in the production deployment when
// this code was written). Refreshes the queue overview when done so the
// counts move visibly.
const workerBackfillBusy = ref(false);
const workerBackfillToast = ref("");
async function onBackfillCompleted() {
  if (!isSuperAdmin.value || workerBackfillBusy.value) return;
  workerBackfillBusy.value = true;
  workerBackfillToast.value = "";
  try {
    const text = await edgesonicPost("work/backfillCompleted", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    workerBackfillToast.value = t("settings.common.workerPool.backfillDoneToast", {
      applied: data.applied || 0,
      processed: data.processed || 0,
      failed: data.failed || 0,
    });
    await loadWorkerStatus();
  } catch (e: unknown) {
    workerBackfillToast.value = e instanceof Error ? e.message : String(e);
  }
  workerBackfillBusy.value = false;
}

// 110 — admin trigger for /edgesonic/work/recheckMetadataNow. Runs the same
// selection the cron tick (metadata_recheck_interval_hours) uses, bypassing
// its cadence gate: dispatches a browser-pool metadata re-check for
// tag_scanned=2 rows (unsupported container format) and tag_scanned=1 rows
// still missing lyrics/disc despite the album already having a cover.
const recheckMetadataBusy = ref(false);
const recheckMetadataToast = ref("");
async function onRecheckMetadataNow() {
  if (!isSuperAdmin.value || recheckMetadataBusy.value) return;
  recheckMetadataBusy.value = true;
  recheckMetadataToast.value = "";
  try {
    const text = await edgesonicPost("work/recheckMetadataNow", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    recheckMetadataToast.value = t("settings.common.workerPool.recheckDoneToast", {
      dispatched: data.dispatched || 0,
      unsupported: data.unsupportedFormat || 0,
      incomplete: data.lyricsOrDiscIncomplete || 0,
      badDuration: data.implausibleWavDuration || 0,
    });
    await loadWorkerStatus();
  } catch (e: unknown) {
    recheckMetadataToast.value = e instanceof Error ? e.message : String(e);
  }
  recheckMetadataBusy.value = false;
}

// 113 — admin trigger for /edgesonic/work/backfillLrcNow. Scans song_masters
// still missing lyrics for a sibling .lrc file next to their audio source
// and fills them in directly (no work_queue involved — a sidecar read is a
// small R2/WebDAV GET the Worker can do itself).
const backfillLrcBusy = ref(false);
const backfillLrcToast = ref("");
async function onBackfillLrcNow() {
  if (!isSuperAdmin.value || backfillLrcBusy.value) return;
  backfillLrcBusy.value = true;
  backfillLrcToast.value = "";
  try {
    const text = await edgesonicPost("work/backfillLrcNow", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    backfillLrcToast.value = t("settings.common.workerPool.lrcBackfillDoneToast", {
      filled: data.filled || 0,
      candidates: data.candidates || 0,
    });
  } catch (e: unknown) {
    backfillLrcToast.value = e instanceof Error ? e.message : String(e);
  }
  backfillLrcBusy.value = false;
}

// 078 — maintenance: cleanup duplicate album cover bindings. Calls
// /edgesonic/maintenance/cleanupDuplicateCovers, surfaces groups/cleared
// counts in a toast, and tolerates 0/0 (no-op) gracefully. R2 objects are
// NOT deleted — only the album.cover_r2_key column is freed for the freed
// rows, so a subsequent getCoverArt will re-resolve per-album.
const cleanupCoversBusy = ref(false);
const cleanupCoversToast = ref("");
async function onCleanupDuplicateCovers() {
  if (!isSuperAdmin.value || cleanupCoversBusy.value) return;
  cleanupCoversBusy.value = true;
  cleanupCoversToast.value = "";
  try {
    const text = await edgesonicPost("maintenance/cleanupDuplicateCovers", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    cleanupCoversToast.value = t("settings.common.maintenance.cleanupCoversDoneToast", {
      groups: data.groups || 0,
      cleared: data.cleared || 0,
    });
  } catch (e: unknown) {
    cleanupCoversToast.value = t("settings.common.maintenance.cleanupCoversFailed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  cleanupCoversBusy.value = false;
}

// 080 — manually trigger the same logic 052a's workReclaim runs on cron.
// Useful when CF schedules are empty (post-deploy, before ensureDefaultCron)
// and a browser worker has left rows stuck in status='claimed'. The endpoint
// returns the breakdown (reclaimed/requeued/failed) and we surface it in a
// toast so the operator can see what changed at a glance.
const reclaimBusy = ref(false);
const reclaimToast = ref("");
async function onReclaimStaleWork() {
  if (!isSuperAdmin.value || reclaimBusy.value) return;
  reclaimBusy.value = true;
  reclaimToast.value = "";
  try {
    const text = await edgesonicPost("maintenance/reclaimStaleWork", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    reclaimToast.value = t("settings.common.maintenance.reclaimDoneToast", {
      reclaimed: data.reclaimed || 0,
      requeued: data.requeued || 0,
      failed: data.failed || 0,
    });
  } catch (e: unknown) {
    reclaimToast.value = t("settings.common.maintenance.reclaimFailed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  reclaimBusy.value = false;
}

// 082 — manually re-queue rows stuck at status='failed'. After a buggy bundle
// burns through attempts the deterministic-id INSERT OR IGNORE means scan
// can't dispatch them again; this knob flips them back to queued so a fresh
// (presumably fixed) bundle can pick them up.
const resetFailedBusy = ref(false);
const resetFailedToast = ref("");
async function onResetFailedWork() {
  if (!isSuperAdmin.value || resetFailedBusy.value) return;
  if (!confirm(t("settings.common.maintenance.resetFailedConfirm"))) return;
  resetFailedBusy.value = true;
  resetFailedToast.value = "";
  try {
    const text = await edgesonicPost("maintenance/resetFailedWork", {});
    const data = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "rejected");
    resetFailedToast.value = t("settings.common.maintenance.resetFailedDoneToast", {
      reset: data.reset || 0,
    });
  } catch (e: unknown) {
    resetFailedToast.value = t("settings.common.maintenance.resetFailedFailed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  resetFailedBusy.value = false;
}

async function clearLastfm() {
  lastfmBusy.value = true;
  try {
    const data = JSON.parse(await edgesonicPost("features/userSetting", {
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
interface Credential { id: string; label: string; lastUsed: number; createdAt: number; streamProxyStrategy: string; }
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
      streamProxyStrategy: r.streamProxyStrategy || "always",
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

// 082 — Rename a credential's label in place. Triggered by the row input's
// blur/Enter when the value differs from the persisted label. We snapshot the
// original on focus so blur knows whether to fire — see the template's
// @focus/@blur handlers below. On failure we revert the local mutation by
// reloading the list (cheap; the table is per-user and capped at 64).
async function updateCredentialLabel(cr: { id: string; label: string }, newLabel: string) {
  const trimmed = newLabel.trim();
  if (trimmed === cr.label) return;            // no-op — user pressed blur with no change
  if (trimmed.length > 200) {
    showToast(t("settings.clients.labelTooLong"), "error");
    // Reload to snap the oversized input back to the persisted value — the
    // server would have rejected this anyway (400 Label too long), so we
    // skip the round-trip and just resync from D1.
    await loadCredentials();
    return;
  }
  try {
    const xml = await edgesonicPost("auth/credentials/update", { id: cr.id, label: trimmed });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    cr.label = trimmed;
    showToast(t("settings.clients.labelSaved"));
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
    await loadCredentials();                   // resync UI to server truth
  }
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

// 092 — Update a credential's stream proxy strategy. Triggered by the
// per-row <select>. Commits immediately; on failure reloads the list so
// the dropdown snaps back to the persisted value.
const STRATEGY_OPTIONS: Array<{ value: string; key: string }> = [
  { value: "always", key: "settings.clients.strategyAlways" },
  { value: "never", key: "settings.clients.strategyNever" },
  { value: "r2_only", key: "settings.clients.strategyR2Only" },
  { value: "webdav_only", key: "settings.clients.strategyWebdavOnly" },
];
async function updateCredentialStrategy(cr: { id: string; label: string; streamProxyStrategy: string }, newStrategy: string) {
  if (newStrategy === cr.streamProxyStrategy) return;
  try {
    const xml = await edgesonicPost("auth/credentials/update", { id: cr.id, label: cr.label, streamProxyStrategy: newStrategy });
    if (/status="failed"/.test(xml)) throw new Error("rejected");
    cr.streamProxyStrategy = newStrategy;
    showToast(t("settings.clients.strategySaved"));
  } catch {
    showToast(t("settings.clients.loadFailed"), "error");
    await loadCredentials();
  }
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
  // 054 — pull CF status + existing cron + analytics for the super-admin.
  if (isSuperAdmin.value) {
    loadCfStatus();
    loadCfCron();
    loadCfAnalytics();
  }
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

    <!-- ============ USER ============ -->
    <section class="settings-section card" :class="{ open: open.user }">
      <button class="section-header" @click="toggleSection('user')">
        <span class="section-title">{{ t("settings.user.title") }}</span>
        <span class="section-caret">{{ open.user ? "−" : "+" }}</span>
      </button>

      <div v-show="open.user" class="section-body">
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
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </section>

    <!-- ============ SYSTEM ============ -->
    <section class="settings-section card" :class="{ open: open.system }">
      <button class="section-header" @click="toggleSection('system')">
        <span class="section-title">{{ t("settings.system.title") }}</span>
        <span class="section-caret">{{ open.system ? "−" : "+" }}</span>
      </button>

      <div v-show="open.system" class="section-body">
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
                <option value="browser_pool">{{ t("settings.common.transcode.engineBrowserPool") }}</option>
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

        <!-- 043/110 — Last.fm API key (per-user setting) -->
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
              autocomplete="off"
            />
          </label>
          <div class="tc-actions">
            <button
              v-if="lastfmKeySet"
              class="btn-secondary"
              :disabled="lastfmBusy"
              @click="clearLastfm"
              style="margin-right: 0.6rem"
            >
              {{ t("settings.common.lastfm.clear") }}
            </button>
            <button
              class="btn-primary"
              :disabled="lastfmBusy || !lastfmKeyInput"
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

        <!-- 065 — Cross-Origin Isolation (COOP/COEP) -->
        <div class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.crossOriginIsolation.title") }}</span>
            <span class="status-badge" :class="cioLive ? 'success' : 'muted'">
              {{ cioLive ? t("settings.common.crossOriginIsolation.live") : t("settings.common.crossOriginIsolation.notLive") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.crossOriginIsolation.hint") }}
          </p>
          <div class="transcode-grid">
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.crossOriginIsolation.toggleLabel") }}</span>
              <span class="scan-toggle">
                <input
                  type="checkbox"
                  v-model="cioEnabled"
                  :disabled="!isSuperAdmin"
                />
                <span>{{ cioEnabled ? t("common.on") : t("common.off") }}</span>
              </span>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.crossOriginIsolation.toggleDesc") }}</p>

            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!isSuperAdmin || cioBusy"
                @click="saveCio"
              >
                {{ t("settings.common.crossOriginIsolation.save") }}
              </button>
            </div>
          </div>
        </div>

        <!-- 054 — Cloudflare integration -->
        <div v-if="isSuperAdmin" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.cf.title") }}</span>
            <span class="status-badge" :class="cfStatus.configured ? 'success' : 'muted'">
              {{ cfStatus.configured ? t("settings.common.cf.configured") : t("settings.common.cf.unconfigured") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.cf.desc") }}
          </p>

          <div class="transcode-grid">
            <!-- Account ID -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.cf.accountId") }}</span>
              <input
                v-model="cfAccountId"
                type="text"
                class="form-input"
                :placeholder="t('settings.common.cf.accountIdPlaceholder')"
                autocomplete="off"
              />
            </label>

            <!-- Token -->
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.cf.token") }}</span>
              <input
                v-model="cfToken"
                type="password"
                class="form-input"
                :placeholder="cfStatus.configured ? '••••' + cfStatus.tokenLast4 : t('settings.common.cf.tokenPlaceholder')"
                autocomplete="off"
              />
            </label>

            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="!cfStatus.configured || cfTestBusy"
                @click="testCfConn"
                style="margin-right: 0.6rem"
              >
                {{ t("settings.common.cf.test") }}
              </button>
              <button
                class="btn-primary"
                :disabled="cfBusy || !cfToken || !cfAccountId"
                @click="saveCfToken"
              >
                {{ t("settings.common.cf.save") }}
              </button>
            </div>
          </div>

          <hr style="margin: 0.8rem 0; border: none; border-top: 1px dashed var(--color-border-subtle)" />

          <!-- Cron -->
          <div class="transcode-grid">
            <label class="tc-row tc-row-block">
              <span class="tc-key">{{ t("settings.common.cf.cron") }}</span>
              <textarea
                v-model="cronExpression"
                rows="3"
                class="form-input"
                :placeholder="t('settings.common.cf.cronPlaceholder')"
                style="resize: vertical; font-family: var(--font-mono);"
              ></textarea>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.cf.cronHint") }}</p>

            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="cronBusy"
                @click="loadCfCron"
                style="margin-right: 0.6rem"
              >
                {{ t("settings.common.cf.loadCron") }}
              </button>
              <button
                class="btn-primary"
                :disabled="!cfStatus.configured || cronBusy"
                @click="saveCron"
              >
                {{ t("settings.common.cf.saveCron") }}
              </button>
            </div>

            <!-- 067 — Post-deploy default cron restore -->
            <p class="feature-desc tc-desc" style="margin-top: 0.6rem; color: var(--color-accent-primary)">
              {{ t("settings.common.cf.ensureCronWarning") }}
            </p>
            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="!cfStatus.configured || cfEnsureCronBusy"
                @click="ensureDefaultCron"
              >
                {{ t("settings.common.cf.ensureCron") }}
              </button>
            </div>
            <p class="feature-desc tc-desc">{{ t("settings.common.cf.ensureCronDesc") }}</p>
          </div>

          <hr style="margin: 0.8rem 0; border: none; border-top: 1px dashed var(--color-border-subtle)" />

          <!-- Analytics -->
          <div class="sub-header" style="margin-top: 0.3rem">
            <span class="mono-label">{{ t("settings.common.cf.analytics") }}</span>
            <button class="btn-secondary btn-sm" :disabled="cfAnalyticsBusy" @click="loadCfAnalytics">
              {{ t("settings.common.cf.refresh") }}
            </button>
          </div>
          <div v-if="cfAnalytics && cfAnalytics.available" class="worker-counts-row">
            <span class="worker-count">{{ t("settings.common.cf.requests") }}: {{ cfAnalytics.requests }}</span>
            <span class="worker-count" :class="(cfAnalytics.errors || 0) > 0 ? 'worker-count-failed' : ''">
              {{ t("settings.common.cf.errors") }}: {{ cfAnalytics.errors }}
            </span>
            <span class="worker-count">{{ t("settings.common.cf.errorRate") }}: {{ ((cfAnalytics.errorRate || 0) * 100).toFixed(2) }}%</span>
            <span class="worker-count">{{ t("settings.common.cf.cpuMs") }}: {{ cfAnalytics.cpuMs }}</span>
            <span class="worker-count">{{ t("settings.common.cf.cpuP99Ms") }}: {{ cfAnalytics.cpuP99Ms }}</span>
          </div>
          <div v-else-if="cfAnalytics && !cfAnalytics.available" class="error-panel">
             <code class="error-text">
               {{ t("settings.common.cf.analyticsUnavailable", { error: cfAnalytics.error || "—" }) }}
             </code>
           </div>
         </div>

        <!-- 091/092 — R2 + WebDAV presigned URL direct stream -->
        <div v-if="isSuperAdmin" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">{{ t("settings.common.presign.title") }}</span>
            <span class="status-badge" :class="r2SecretsConfigured ? 'success' : 'warning'">
              {{ r2SecretsConfigured
                ? t("settings.common.presign.secretsConfigured")
                : t("settings.common.presign.secretsMissing") }}
            </span>
          </div>
          <p class="feature-desc tc-desc" style="margin-left:0">
            {{ t("settings.common.presign.hint") }}
          </p>

          <!-- R2 secrets missing banner — the most important hint -->
          <div v-if="!r2SecretsConfigured" class="presign-warning">
            <p class="feature-desc" style="margin:0;color:var(--color-accent-warning,#b45309)">
              {{ t("settings.common.presign.r2SecretsMissingHint") }}
            </p>
            <ul class="presign-env-list">
              <li><code>R2_ACCESS_KEY_ID</code></li>
              <li><code>R2_SECRET_ACCESS_KEY</code></li>
              <li><code>CF_ACCOUNT_ID</code> <span style="opacity:0.7">— from Cloudflare integration block above</span></li>
            </ul>
            <p class="feature-desc" style="margin:0.4rem 0 0;color:var(--color-text-muted)">
              {{ t("settings.common.presign.secretPushHint") }}
            </p>
          </div>

          <div class="transcode-grid">
            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.presign.r2Toggle") }}</span>
              <span class="scan-toggle">
                <input type="checkbox" v-model="r2PresignEnabled" :disabled="!isSuperAdmin" />
                <span>{{ r2PresignEnabled ? t("common.on") : t("common.off") }}</span>
              </span>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.presign.r2ToggleDesc") }}</p>
            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!isSuperAdmin || r2PresignBusy"
                @click="saveR2Presign"
              >
                {{ t("settings.common.presign.save") }}
              </button>
            </div>

            <label class="tc-row">
              <span class="tc-key">{{ t("settings.common.presign.webdavToggle") }}</span>
              <span class="scan-toggle">
                <input type="checkbox" v-model="webdavPresignEnabled" :disabled="!isSuperAdmin" />
                <span>{{ webdavPresignEnabled ? t("common.on") : t("common.off") }}</span>
              </span>
            </label>
            <p class="feature-desc tc-desc">{{ t("settings.common.presign.webdavToggleDesc") }}</p>
            <div class="tc-actions">
              <button
                class="btn-primary"
                :disabled="!isSuperAdmin || webdavPresignBusy"
                @click="saveWebdavPresign"
              >
                {{ t("settings.common.presign.save") }}
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

            <!-- 088 — Concurrency knob. Admin-writable; non-admin sees the
                 value but the input + save button are disabled. -->
            <div class="tc-row">
              <span class="tc-key">{{ t("settings.common.workerPool.maxConcurrent") }}</span>
              <span class="scan-toggle">
                <input
                  type="number"
                  min="1"
                  max="8"
                  step="1"
                  v-model.number="maxConcurrentInput"
                  class="form-input"
                  style="width: 5rem"
                  :disabled="!isSuperAdmin"
                />
                <button
                  class="btn-secondary btn-sm"
                  :disabled="!isSuperAdmin || maxConcurrentBusy"
                  @click="saveMaxConcurrent"
                  style="margin-left: 0.6rem"
                >
                  {{ t("common.save") }}
                </button>
              </span>
            </div>
            <p class="feature-desc tc-desc">{{ t("settings.common.workerPool.maxConcurrentHint") }}</p>
            <div class="tc-row">
              <span class="tc-key">{{ t("settings.common.workerPool.currentConcurrency") }}</span>
              <span class="feature-desc">{{ workerPool.currentConcurrency }} / {{ workerPool.maxConcurrent }}</span>
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

            <!-- 077 — backfill completed metadata rows that finished before the
                 /work/submit cascade was wired in. Admin-only; idempotent. -->
            <div class="tc-row" style="margin-top: 0.6rem">
              <span class="tc-key">{{ t("settings.common.workerPool.backfillLabel") }}</span>
              <span class="feature-desc">{{ t("settings.common.workerPool.backfillDesc") }}</span>
            </div>
            <div class="tc-actions">
              <button
                class="btn-secondary"
                :disabled="workerBackfillBusy"
                @click="onBackfillCompleted"
              >
                {{ workerBackfillBusy
                  ? t("settings.common.workerPool.backfillRunning")
                  : t("settings.common.workerPool.backfillButton") }}
              </button>
              <span v-if="workerBackfillToast" class="feature-desc" style="margin-left: 0.6rem">{{ workerBackfillToast }}</span>
            </div>

            <!-- 110 — cron-driven metadata re-check: interval + manual trigger
                 (unsupported-format retries + lyrics/disc backfill). -->
            <div class="tc-row" style="margin-top: 0.6rem">
              <span class="tc-key">{{ t("settings.common.workerPool.recheckLabel") }}</span>
              <span class="feature-desc">{{ t("settings.common.workerPool.recheckDesc") }}</span>
            </div>
            <div class="tc-actions">
              <input
                v-model.number="metadataRecheckIntervalHours"
                type="number" min="0" max="168" step="1"
                class="free-alloc-input"
                style="width: 5rem"
              />
              <button
                class="btn-sm btn-secondary"
                :disabled="metadataRecheckIntervalBusy"
                @click="saveMetadataRecheckInterval"
              >
                {{ t("settings.common.scan.save") }}
              </button>
              <button
                class="btn-secondary"
                :disabled="recheckMetadataBusy"
                @click="onRecheckMetadataNow"
              >
                {{ recheckMetadataBusy
                  ? t("settings.common.workerPool.recheckRunning")
                  : t("settings.common.workerPool.recheckButton") }}
              </button>
            </div>
            <div v-if="recheckMetadataToast" class="tc-actions">
              <span class="feature-desc">{{ recheckMetadataToast }}</span>
            </div>

            <!-- 113 — cron-driven LRC sidecar backfill: interval + manual
                 trigger. Scans song_masters still missing lyrics for a
                 sibling .lrc file next to the audio source (never retried by
                 110's recheck, which only re-parses embedded tags). -->
            <div class="tc-row" style="margin-top: 0.6rem">
              <span class="tc-key">{{ t("settings.common.workerPool.lrcBackfillLabel") }}</span>
              <span class="feature-desc">{{ t("settings.common.workerPool.lrcBackfillDesc") }}</span>
            </div>
            <div class="tc-actions">
              <input
                v-model.number="lrcBackfillIntervalHours"
                type="number" min="0" max="168" step="1"
                class="free-alloc-input"
                style="width: 5rem"
              />
              <button
                class="btn-sm btn-secondary"
                :disabled="lrcBackfillIntervalBusy"
                @click="saveLrcBackfillInterval"
              >
                {{ t("settings.common.scan.save") }}
              </button>
              <button
                class="btn-secondary"
                :disabled="backfillLrcBusy"
                @click="onBackfillLrcNow"
              >
                {{ backfillLrcBusy
                  ? t("settings.common.workerPool.lrcBackfillRunning")
                  : t("settings.common.workerPool.lrcBackfillButton") }}
              </button>
            </div>
            <div v-if="backfillLrcToast" class="tc-actions">
              <span class="feature-desc">{{ backfillLrcToast }}</span>
            </div>
          </div>
        </div>

        <!-- 078 — Maintenance tools (super-admin only). Lives in Common because
             that's where 077 backfill lives; both are "fix the DB state" knobs
             tied to historical data drift. Each tool here MUST be idempotent
             and safe to re-run — no destructive cascades. -->
        <div v-if="isSuperAdmin" class="sub-block">
          <div class="sub-header">
            <span class="mono-label">🔧 {{ t("settings.common.maintenance.title") }}</span>
          </div>
          <p class="feature-desc" style="margin: 0 0 0.6rem 0">
            {{ t("settings.common.maintenance.desc") }}
          </p>

          <div class="tc-row">
            <span class="tc-key">{{ t("settings.common.maintenance.cleanupCovers") }}</span>
            <span class="feature-desc">{{ t("settings.common.maintenance.cleanupCoversDesc") }}</span>
          </div>
          <div class="tc-actions">
            <button
              class="btn-secondary"
              :disabled="cleanupCoversBusy"
              @click="onCleanupDuplicateCovers"
            >
              {{ cleanupCoversBusy
                ? t("settings.common.maintenance.cleanupCoversRunning")
                : t("settings.common.maintenance.cleanupCoversButton") }}
            </button>
            <span v-if="cleanupCoversToast" class="feature-desc" style="margin-left: 0.6rem">{{ cleanupCoversToast }}</span>
          </div>

          <!-- 080 — manual reclaim of stale work_queue claims. Mirrors the
               052a scheduled sweep so the operator has a "kick" button while
               CF cron schedules are empty (post-deploy / before ensureDefaultCron). -->
          <div class="tc-row">
            <span class="tc-key">{{ t("settings.common.maintenance.reclaimTitle") }}</span>
            <span class="feature-desc">{{ t("settings.common.maintenance.reclaimDesc") }}</span>
          </div>
          <div class="tc-actions">
            <button
              class="btn-secondary"
              :disabled="reclaimBusy"
              @click="onReclaimStaleWork"
            >
              {{ reclaimBusy
                ? t("settings.common.maintenance.reclaimRunning")
                : t("settings.common.maintenance.reclaimButton") }}
            </button>
            <span v-if="reclaimToast" class="feature-desc" style="margin-left: 0.6rem">{{ reclaimToast }}</span>
          </div>
          <p class="feature-desc" style="margin: 0.4rem 0 0 0">
            {{ t("settings.common.maintenance.reclaimHint") }}
          </p>

          <!-- 082 — re-queue rows stuck at status='failed'. Browser bundle
               regressions can burn through attempts on every task; once they
               settle at 'failed' the deterministic-id scan can't dispatch
               them again until they're flipped back. -->
          <div class="tc-row">
            <span class="tc-key">{{ t("settings.common.maintenance.resetFailedTitle") }}</span>
            <span class="feature-desc">{{ t("settings.common.maintenance.resetFailedDesc") }}</span>
          </div>
          <div class="tc-actions">
            <button
              class="btn-secondary"
              :disabled="resetFailedBusy"
              @click="onResetFailedWork"
            >
              {{ resetFailedBusy
                ? t("settings.common.maintenance.resetFailedRunning")
                : t("settings.common.maintenance.resetFailedButton") }}
            </button>
            <span v-if="resetFailedToast" class="feature-desc" style="margin-left: 0.6rem">{{ resetFailedToast }}</span>
          </div>
          <p class="feature-desc" style="margin: 0.4rem 0 0 0">
            {{ t("settings.common.maintenance.resetFailedHint") }}
          </p>
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

        <div v-else class="table-wrap session-table" style="--grid-cols: 1fr 1.4fr 1fr 1fr 1.2fr auto">
          <div class="table-header">
            <span>ID</span>
            <span>{{ t("settings.clients.colLabel") }}</span>
            <span>{{ t("settings.clients.colCreated") }}</span>
            <span>{{ t("settings.clients.colLastUsed") }}</span>
            <span>{{ t("settings.clients.colStrategy") }}</span>
            <span></span>
          </div>
          <div v-for="cr in credentials" :key="cr.id" class="table-row">
            <span class="session-id" :title="cr.id">{{ cr.id }}</span>
            <!-- 082 — inline label editor. blur and Enter commit; Esc reverts
                 by reloading the list. We keep the original value in a data-
                 attribute so the handler can detect "no change" cheaply. -->
            <span class="session-ua">
              <input
                class="form-input cred-label-edit"
                :value="cr.label"
                :placeholder="t('settings.clients.labelEditPlaceholder')"
                maxlength="200"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
                @keydown.esc="loadCredentials()"
                @blur="updateCredentialLabel(cr, ($event.target as HTMLInputElement).value)"
              />
            </span>
            <span class="session-time">{{ formatTs(cr.createdAt) }}</span>
            <span class="session-time">{{ cr.lastUsed ? formatTs(cr.lastUsed) : t("settings.clients.never") }}</span>
            <!-- 092 — per-credential stream proxy strategy. 302 direct-stream
                 can be toggled per client for backward compatibility. -->
            <span class="session-strategy">
              <select
                class="form-input cred-strategy-select"
                :value="cr.streamProxyStrategy"
                @change="updateCredentialStrategy(cr, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="opt in STRATEGY_OPTIONS" :key="opt.value" :value="opt.value">{{ t(opt.key) }}</option>
              </select>
            </span>
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
/* 082 — inline label editor inside the credential table row: tight padding so
   it doesn't push the row taller than the read-only siblings. */
.cred-label-edit { width: 100%; padding: 0.25rem 0.4rem; font-size: 0.85rem; }
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

/* --- 091/092 presign warning banner --- */
.presign-warning {
  margin: 0.6rem 0 0.8rem;
  padding: 0.6rem 0.8rem;
  border-left: 3px solid var(--color-accent-warning, #b45309);
  background: var(--color-surface-2, rgba(255,255,255,0.03));
  border-radius: 4px;
}
.presign-env-list {
  margin: 0.4rem 0 0.4rem 1.2rem;
  padding: 0;
  list-style: disc;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
}
.presign-env-list li { margin: 0.15rem 0; }
.presign-env-list code { background: none; padding: 0; color: inherit; }

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
