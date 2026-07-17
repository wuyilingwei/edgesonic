
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";
import { useWorkerPool } from "../stores/workerPool";

const { t } = useI18n();
const { isLoggedIn, username, isAdmin, isSuperAdmin, level, storageFetch, edgesonicFetch, edgesonicPost, handleAuthError } = useAuth();
const workerPool = useWorkerPool();
const loading = ref(true);
const stats = ref({ artists: 0, albums: 0, songs: 0, sources: 0, users: 0 });

interface StorageRow { source_type: string; count: number; bytes: number }
interface StorageStats {
  breakdown: StorageRow[];
  r2CoverCount: number;
  r2CoverBytes: number;
  freeAllocationGb: number;
}
const storageStats = ref<StorageStats | null>(null);
const storageLoading = ref(false);
const freeAllocInput = ref(10);
const freeAllocSaving = ref(false);

const R2_PRICE_PER_GB = 0.015;

const r2Row = computed(() =>
  storageStats.value?.breakdown.find((r) => r.source_type === "r2") ?? { source_type: "r2", count: 0, bytes: 0 },
);
const r2TotalBytes = computed(() => r2Row.value.bytes + (storageStats.value?.r2CoverBytes ?? 0));
const r2Gb = computed(() => r2TotalBytes.value / 1024 ** 3);
const billableGb = computed(() => Math.max(0, r2Gb.value - freeAllocInput.value));
const monthlyCost = computed(() => billableGb.value * R2_PRICE_PER_GB);

function fmtBytes(b: number): string {
  if (b <= 0) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

async function loadStorageStats() {
  storageLoading.value = true;
  try {
    const text = await edgesonicFetch("stats/storage");
    const data = JSON.parse(text) as { ok?: boolean } & Partial<StorageStats>;
    if (data.ok) {
      storageStats.value = {
        breakdown: data.breakdown ?? [],
        r2CoverCount: data.r2CoverCount ?? 0,
        r2CoverBytes: data.r2CoverBytes ?? 0,
        freeAllocationGb: data.freeAllocationGb ?? 10,
      };
      freeAllocInput.value = storageStats.value.freeAllocationGb;
    }
  } catch { /* stay null */ } finally {
    storageLoading.value = false;
  }
}

async function saveFreeAlloc() {
  if (freeAllocSaving.value) return;
  freeAllocSaving.value = true;
  try {
    await edgesonicPost("features/updateString", { key: "r2_free_allocation_gb", value: String(freeAllocInput.value) });
    if (storageStats.value) storageStats.value.freeAllocationGb = freeAllocInput.value;
  } catch { /* ignore */ } finally {
    freeAllocSaving.value = false;
  }
}
const recentAlbums = ref<Array<{ id: string; name: string; artist: string; year: string }>>([]);

type CronStatus = "checking" | "ok" | "empty" | "unconfigured" | "error";
const cronStatus = ref<CronStatus>("checking");

type R2PresignStatus = "checking" | "active" | "inactive" | "error";
const r2presignStatus = ref<R2PresignStatus>("checking");

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };

const edgesonicVersion = ref(__EDGESONIC_VERSION__);
const edgesonicBuildTime = new Date(__EDGESONIC_BUILD_TIME__).toLocaleString();
const releaseVersion = edgesonicVersion.value.replace(/-dev\.[^.]+$/, "");
const isDevelopmentBuild = releaseVersion !== edgesonicVersion.value;
const workerVersion = ref("—");
const latestVersion = ref("");
const updateAvailable = ref(false);
const updateChecking = ref(false);

async function loadVersionInfo() {
  // GitHub latest release check only (version itself is embedded in the bundle).
  updateChecking.value = true;
  try {
    const r2 = await fetch("https://api.github.com/repos/wuyilingwei/edgesonic/releases/latest", { cache: "no-store" });
    if (r2.ok) {
      const rel = await r2.json() as { tag_name?: string };
      const tag = rel.tag_name?.replace(/^v/, "") ?? "";
      latestVersion.value = tag;
      if (tag && tag !== releaseVersion) {
        updateAvailable.value = true;
      }
    }
  } catch { /* offline or rate-limited — stay quiet */ } finally {
    updateChecking.value = false;
  }
}

interface WorkCounts { queued: number; claimed: number; completed: number; failed: number; canceled: number }
interface WorkLoadRow { username: string; n: number }
interface ScanSourceRow { id: string; jobId: string; status: string; total: number; scanned: number; startedAt: number; endedAt: number | null; error: string | null }

const workCounts = ref<WorkCounts>({ queued: 0, claimed: 0, completed: 0, failed: 0, canceled: 0 });
const workLoad = ref<WorkLoadRow[]>([]);
const workError = ref<string>("");
const scanSources = ref<ScanSourceRow[]>([]);
const scanError = ref<string>("");
const resetFailedBusy = ref(false);
const reclaimBusy = ref(false);
const activityToast = ref<string>("");
let activityTimer: number | null = null;
const ACTIVE_POLL_MS = 30_000;
const IDLE_POLL_MS = 120_000;

const totalTasks = computed(() => workCounts.value.queued + workCounts.value.claimed + workCounts.value.completed + workCounts.value.failed);
const progressPct = computed(() => {
  const total = totalTasks.value;
  if (total === 0) return 0;
  return Math.min(100, Math.round((workCounts.value.completed / total) * 1000) / 10);
});
const latestScan = computed<ScanSourceRow | null>(() => {
  if (scanSources.value.length === 0) return null;
  const sorted = [...scanSources.value].sort((a, b) => {
    const ka = a.endedAt ?? a.startedAt;
    const kb = b.endedAt ?? b.startedAt;
    return kb - ka;
  });
  return sorted[0];
});

function showToast(msg: string) {
  activityToast.value = msg;
  window.setTimeout(() => { if (activityToast.value === msg) activityToast.value = ""; }, 3500);
}

function relativeTime(epochSec: number | null | undefined): string {
  if (!epochSec) return t("dashboard.scanStatus.never");
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - epochSec);
  if (diffSec < 60) return t("dashboard.scanStatus.relative.justNow");
  if (diffSec < 3600) return t("dashboard.scanStatus.relative.minutesAgo", { n: Math.floor(diffSec / 60) });
  if (diffSec < 86_400) return t("dashboard.scanStatus.relative.hoursAgo", { n: Math.floor(diffSec / 3600) });
  return t("dashboard.scanStatus.relative.daysAgo", { n: Math.floor(diffSec / 86_400) });
}

async function loadWorkStatus() {
  try {
    const text = await edgesonicFetch("work/status");
    const parsed = JSON.parse(text) as { ok?: boolean; counts?: Partial<WorkCounts>; load?: WorkLoadRow[]; error?: string };
    if (!parsed.ok) {
      workError.value = parsed.error || "load failed";
      return;
    }
    workCounts.value = {
      queued: parsed.counts?.queued ?? 0,
      claimed: parsed.counts?.claimed ?? 0,
      completed: parsed.counts?.completed ?? 0,
      failed: parsed.counts?.failed ?? 0,
      canceled: parsed.counts?.canceled ?? 0,
    };
    workLoad.value = Array.isArray(parsed.load) ? parsed.load : [];
    workError.value = "";
  } catch (e) {
    if (handleAuthError(e)) {
      showToast(t("common.sessionExpired"));
      stopActivityPolling();
      return;
    }
    workError.value = e instanceof Error ? e.message : String(e);
  }
}

async function loadScanStatus() {
  try {
    const xml = await storageFetch("scan/status");
    const rows = parseXmlAttrs(xml, "source");
    scanSources.value = rows.map((r) => ({
      id: r.id || "",
      jobId: r.jobId || "",
      status: r.status || "idle",
      total: parseInt(r.total || "0", 10) || 0,
      scanned: parseInt(r.scanned || "0", 10) || 0,
      startedAt: parseInt(r.startedAt || "0", 10) || 0,
      endedAt: r.endedAt ? parseInt(r.endedAt, 10) || null : null,
      error: r.error || null,
    }));
    scanError.value = "";
  } catch (e) {
    if (handleAuthError(e)) {
      showToast(t("common.sessionExpired"));
      stopActivityPolling();
      return;
    }
    scanError.value = e instanceof Error ? e.message : String(e);
  }
}

async function refreshActivity() {
  await Promise.all([loadWorkStatus(), loadScanStatus()]);
}

const activityActive = computed(() =>
  workCounts.value.queued + workCounts.value.claimed > 0 ||
  scanSources.value.some((s) => s.status === "running"),
);

function startActivityPolling() {
  if (!isSuperAdmin.value) return;
  scheduleNextActivityPoll();
}

function scheduleNextActivityPoll() {
  if (activityTimer !== null) return;
  const delay = activityActive.value ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  activityTimer = window.setTimeout(async () => {
    activityTimer = null;
    await refreshActivity();
    scheduleNextActivityPoll();
  }, delay);
}

function stopActivityPolling() {
  if (activityTimer !== null) {
    window.clearTimeout(activityTimer);
    activityTimer = null;
  }
}

function onActivityVisibility() {
  if (document.visibilityState === "hidden") {
    stopActivityPolling();
  } else if (isSuperAdmin.value) {
    void refreshActivity();
    startActivityPolling();
  }
}

async function onResetFailedWork() {
  // Mirrors the Settings → Maintenance panel button so admins don't have to
  // bounce away from the Dashboard when they spot a failed queue here. The
  // confirm + warning text intentionally matches 082's so behaviour is
  // identical regardless of where the click came from.
  if (resetFailedBusy.value) return;
  if (!window.confirm(t("settings.common.maintenance.resetFailedConfirm"))) return;
  resetFailedBusy.value = true;
  try {
    const text = await edgesonicPost("maintenance/resetFailedWork", {});
    const parsed = JSON.parse(text) as { ok?: boolean; reset?: number; error?: string };
    if (parsed.ok) {
      showToast(t("settings.common.maintenance.resetFailedDoneToast", { reset: parsed.reset ?? 0 }));
      await loadWorkStatus();
    } else {
      showToast(t("settings.common.maintenance.resetFailedFailed", { error: parsed.error || "unknown" }));
    }
  } catch (e) {
    showToast(t("settings.common.maintenance.resetFailedFailed", { error: e instanceof Error ? e.message : String(e) }));
  } finally {
    resetFailedBusy.value = false;
  }
}

async function onReclaimStaleWork() {
  if (reclaimBusy.value) return;
  reclaimBusy.value = true;
  try {
    const text = await edgesonicPost("maintenance/reclaimStaleWork", {});
    const parsed = JSON.parse(text) as { ok?: boolean; reclaimed?: number; requeued?: number; failed?: number; error?: string };
    if (parsed.ok) {
      showToast(t("settings.common.maintenance.reclaimDoneToast", {
        reclaimed: parsed.reclaimed ?? 0,
        requeued: parsed.requeued ?? 0,
        failed: parsed.failed ?? 0,
      }));
      await loadWorkStatus();
    } else {
      showToast(t("settings.common.maintenance.reclaimFailed", { error: parsed.error || "unknown" }));
    }
  } catch (e) {
    showToast(t("settings.common.maintenance.reclaimFailed", { error: e instanceof Error ? e.message : String(e) }));
  } finally {
    reclaimBusy.value = false;
  }
}

onMounted(async () => {
  if (!isLoggedIn.value) return;
  try {
    const [libraryJson, sourceXml, userXml] = await Promise.all([
      edgesonicFetch("stats/library"),
      isAdmin.value ? storageFetch("sources/list") : Promise.resolve(""),
      isAdmin.value ? edgesonicFetch("users/list") : Promise.resolve(""),
    ]);

    // A single real COUNT(*) endpoint for the library stats — exact
    // regardless of size (the earlier search3-based counts capped at 500).
    try {
      const parsed = JSON.parse(libraryJson) as { ok?: boolean; artists?: number; albums?: number; songs?: number };
      if (parsed.ok) {
        stats.value.artists = parsed.artists ?? 0;
        stats.value.albums = parsed.albums ?? 0;
        stats.value.songs = parsed.songs ?? 0;
      }
    } catch { /* leave stats at 0 on parse failure */ }

    if (sourceXml) {
      stats.value.sources = parseXmlAttrs(sourceXml, "source").length;
    }
    // /edgesonic/users/list is now JSON; older XML path stayed only
    // because Dashboard used parseXmlAttrs to count rows. JSON.parse-and-count
    // here mirrors the new Users.vue load().
    if (userXml) {
      try {
        const parsed = JSON.parse(userXml) as { ok?: boolean; users?: unknown[] };
        if (parsed.ok && Array.isArray(parsed.users)) stats.value.users = parsed.users.length;
      } catch { /* leave stats.users at 0 on parse failure */ }
    }

  } catch {
    // Network error or auth failure — leave stats at 0, UI shows skeleton
  } finally {
    loading.value = false;
  }
  cronStatus.value = "ok";
  r2presignStatus.value = "active";
  // version info + update check (all users)
  void loadVersionInfo();
});

onUnmounted(() => {
});
</script>

<template>
  <div class="dashboard">
    <!-- Welcome -->
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("dashboard.label") }}</div>
        <h1 class="page-title">{{ t("dashboard.welcome", { name: username }) }}</h1>
      </div>
      <span class="status-badge" :class="level >= 3 ? 'warning' : level >= 2 ? 'info' : 'success'">
        {{ levelKeys[level] ? t(`users.levels.${levelKeys[level]}`) : t("dashboard.unknown") }}
      </span>
    </div>

    <!-- System Activity (super-admin only). Sits BEFORE stats because it's
         actionable (failed tasks, stale claims) while the stats cards are
         informational. The 080 cron warning lives inside this section so all
         operational signals cluster instead of stacking down the page. -->
    <section v-if="isSuperAdmin" class="system-activity">
      <div class="page-section-header">
        <span class="mono-label">{{ t("dashboard.systemActivity.label") }}</span>
      </div>

      <!-- Cron missing warning. -->
      <div
        v-if="cronStatus === 'empty'"
        class="cron-warning-card"
      >
       <div class="cron-warning-icon">⚠</div>
        <div class="cron-warning-body">
          <div class="cron-warning-title">{{ t("dashboard.cronWarning.title") }}</div>
          <p class="cron-warning-message">{{ t("dashboard.cronWarning.message") }}</p>
          <div class="cron-warning-actions">
            <router-link to="/settings" class="btn-secondary">
              {{ t("dashboard.cronWarning.actionEnsure") }}
            </router-link>
            <router-link to="/settings" class="btn-secondary">
              {{ t("dashboard.cronWarning.actionReclaim") }}
            </router-link>
          </div>
        </div>
      </div>
      <div
        v-else-if="cronStatus === 'unconfigured'"
        class="cron-warning-card cron-warning-info"
      >
       <div class="cron-warning-icon">ⓘ</div>
        <div class="cron-warning-body">
          <div class="cron-warning-title">{{ t("dashboard.cronWarning.unconfiguredTitle") }}</div>
          <p class="cron-warning-message">{{ t("dashboard.cronWarning.unconfiguredMessage") }}</p>
          <div class="cron-warning-actions">
            <router-link to="/settings" class="btn-secondary">
              {{ t("dashboard.cronWarning.actionEnsure") }}
            </router-link>
          </div>
        </div>
      </div>

      <!-- R2 presign inactive hint. -->
      <div
        v-if="r2presignStatus === 'inactive'"
        class="cron-warning-card cron-warning-info"
      >
       <div class="cron-warning-icon">ⓘ</div>
        <div class="cron-warning-body">
          <div class="cron-warning-title">{{ t("dashboard.r2Presign.title") }}</div>
          <p class="cron-warning-message">{{ t("dashboard.r2Presign.message") }}</p>
          <div class="cron-warning-actions">
            <router-link to="/settings" class="btn-secondary">
              {{ t("dashboard.r2Presign.action") }}
            </router-link>
          </div>
        </div>
      </div>

      <!-- Work pool + scan status moved to Tools page. -->
      <!-- Storage + R2 cost moved to Tools page. -->
    </section>

    <!-- Stats -->
    <div class="grid grid-4 stats-grid">
      <div class="stat-card card hoverable">
        <div class="stat-num">
          <span v-if="loading" class="skeleton-text" style="width:3rem">　</span>
          <span v-else>{{ stats.artists }}</span>
        </div>
        <div class="mono-label">{{ t("dashboard.artists") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
      <div class="stat-card card hoverable">
        <div class="stat-num">
          <span v-if="loading" class="skeleton-text" style="width:3rem">　</span>
          <span v-else>{{ stats.albums }}</span>
        </div>
        <div class="mono-label">{{ t("dashboard.albums") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
      <div class="stat-card card hoverable">
        <div class="stat-num">
          <span v-if="loading" class="skeleton-text" style="width:3rem">　</span>
          <span v-else>{{ stats.songs }}</span>
        </div>
        <div class="mono-label">{{ t("dashboard.songs") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
      <div v-if="isAdmin" class="stat-card card hoverable">
        <div class="stat-num">
          <span v-if="loading" class="skeleton-text" style="width:3rem">　</span>
          <span v-else>{{ stats.sources }}</span>
        </div>
        <div class="mono-label">{{ t("dashboard.storageSources") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
      <div v-else class="stat-card card hoverable">
        <div class="stat-num">–</div>
        <div class="mono-label">{{ t("dashboard.online") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
    </div>

    <!-- System Info (all logged-in users) -->
    <div class="card" style="margin-top: 1rem">
      <div class="card-header">
        <span class="card-title">{{ t("dashboard.systemInfo") }}</span>
      </div>
      <div class="info-two-col">
        <div class="info-col">
           <div class="info-row"><span class="info-key">EdgeSonic</span><span class="info-val">v{{ edgesonicVersion }}</span></div>
           <div class="info-row"><span class="info-key">Build</span><span class="info-val">{{ edgesonicBuildTime }}</span></div>
           <div class="info-row"><span class="info-key">{{ t("dashboard.infoApiVersion") }}</span><span class="info-val">1.16.1</span></div>
        <div class="info-row"><span class="info-key">{{ t("dashboard.infoPlatform") }}</span><span class="info-val">Cloudflare Workers</span></div>
        </div>
        <div class="info-col">
          <div v-if="isAdmin" class="info-row"><span class="info-key">{{ t("dashboard.infoUsers") }}</span><span class="info-val">{{ stats.users }}</span></div>
          <div v-if="isAdmin" class="info-row"><span class="info-key">{{ t("dashboard.infoSources") }}</span><span class="info-val">{{ stats.sources }}</span></div>
          <div class="info-row">
            <span class="info-key">GitHub Latest</span>
            <span class="info-val">
              <a v-if="updateAvailable" href="https://github.com/wuyilingwei/edgesonic/releases/latest" target="_blank" rel="noopener" class="update-link">
                v{{ latestVersion }} — 有新版本
              </a>
              <span v-else-if="latestVersion" class="update-current">v{{ latestVersion }} — {{ isDevelopmentBuild ? "当前开发构建" : "已是最新" }}</span>
              <span v-else-if="updateChecking" class="muted">检查中…</span>
              <span v-else class="muted">—</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Storage & R2 Cost Estimation moved to Tools page. -->
  </div>
</template>

<style scoped>
.stats-grid { margin-bottom: 1rem; }
.stat-card { text-align: center; padding: 1.4rem 1rem 1.1rem; }
.stat-num {
  font-family: var(--font-display);
  font-size: 2.4rem;
  color: var(--color-accent-primary);
  line-height: 1.1;
  margin-bottom: 0.2rem;
}

.recent-table { border: 1px solid var(--color-border-subtle); }
.row-name { font-size: var(--fs-md); color: var(--color-text-primary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-sub { font-size: var(--fs-sm); color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-mono { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); }

.info-list { display: flex; flex-direction: column; }
.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0;
}
.info-grid .info-row { border-bottom: 1px solid var(--color-border-subtle); }
.info-two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 2rem;
}
.info-col { display: flex; flex-direction: column; }
.info-col .info-row:last-child { border-bottom: none; }
.info-row {
  display: flex; justify-content: space-between;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--color-border-subtle);
}
.info-row:last-child { border-bottom: none; }
.info-key { font-family: var(--font-mono); font-size: var(--fs-sm); letter-spacing: 0.1em; color: var(--color-text-muted); }
.info-val { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-primary); }

.update-check-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.6rem 0; margin-top: 0.3rem;
  border-top: 1px solid var(--color-border-subtle);
}
.update-link { color: var(--color-accent); text-decoration: none; font-family: var(--font-mono); font-size: var(--fs-sm); }
.update-link:hover { text-decoration: underline; }
.update-current { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); }

/* Cron warning banner. Orange/amber accent for the "empty schedules"
   case (an actionable problem), muted/info accent for the "CF unconfigured"
   case (informational, not blocking). */
.cron-warning-card {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  padding: 1rem 1.2rem;
  margin-bottom: 1rem;
  border: 1px solid #d97706;          /* amber-600 */
  border-left-width: 3px;
  background: rgba(217, 119, 6, 0.06);
  border-radius: 0;
}
.cron-warning-card.cron-warning-info {
  border-color: var(--color-border-subtle);
  border-left-color: var(--color-text-muted);
  background: var(--color-surface-subtle, rgba(255,255,255,0.02));
}
.cron-warning-icon {
  font-size: 1.4rem;
  line-height: 1;
  color: #d97706;
  flex-shrink: 0;
  padding-top: 0.1rem;
}
.cron-warning-info .cron-warning-icon { color: var(--color-text-muted); }
.cron-warning-body { flex: 1; min-width: 0; }
.cron-warning-title {
  font-family: var(--font-display, inherit);
  font-size: var(--fs-md);
  color: var(--color-text-primary);
  margin-bottom: 0.3rem;
}
.cron-warning-message {
  margin: 0 0 0.7rem 0;
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  line-height: 1.5;
}
.cron-warning-actions {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}

/* System activity (super-admin only). Sits above the 4 stat cards;
   work-pool + scan-status share a vertical stack so a tall failed list
   doesn't shove the scan row off to a side column. */
.system-activity {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  margin-bottom: 1.2rem;
}
.page-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.2rem;
  opacity: 0.85;
}

.work-pool-card {
  padding: 1rem 1.1rem 0.9rem;
  border-left: 3px solid var(--color-accent-primary, #6366f1);
  transition: border-left-color 0.3s ease;
}
.work-pool-card.work-pool-failed {
  border-left-color: #ef4444; /* red-500 */
}
.work-pool-card.work-pool-warning {
  border-left-color: #f59e0b; /* amber-500 */
}
.wp-refresh {
  background: transparent;
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-secondary);
  font-size: 0.85rem;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 0;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, transform 0.6s;
}
.wp-refresh:hover { color: var(--color-text-primary); border-color: var(--color-border-strong, var(--color-text-muted)); transform: rotate(180deg); }

.wp-progress-line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-top: 0.5rem;
}
.wp-progress-label {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  text-transform: uppercase;
}
.wp-progress-num {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  color: var(--color-text-primary);
}
.wp-progress-bar {
  margin-top: 0.4rem;
  height: 6px;
  width: 100%;
  background: var(--color-border-subtle);
  border-radius: 0;
  overflow: hidden;
}
.wp-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-accent-primary, #6366f1), var(--color-accent-secondary, #8b5cf6));
  transition: width 0.6s ease;
  min-width: 0;
}
.work-pool-failed .wp-progress-fill {
  background: linear-gradient(90deg, #f59e0b, #ef4444);
}

.wp-counts {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.6rem;
  margin-top: 0.9rem;
}
.wp-count {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-surface-subtle, rgba(255,255,255,0.02));
}
.wp-count-icon { font-size: 0.95rem; line-height: 1; color: var(--color-text-muted); }
.wp-count-label {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  color: var(--color-text-muted);
  text-transform: uppercase;
}
.wp-count-num {
  font-family: var(--font-display, inherit);
  font-size: 1.2rem;
  color: var(--color-text-primary);
}
.wp-count-emphasis { border-color: #ef4444; }
.wp-count-emphasis .wp-count-num { color: #ef4444; }

.wp-workers {
  margin-top: 0.9rem;
  padding-top: 0.7rem;
  border-top: 1px dashed var(--color-border-subtle);
}
.wp-workers-title {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  color: var(--color-text-muted);
  text-transform: uppercase;
  margin-bottom: 0.35rem;
}
.wp-workers-empty {
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
  font-style: italic;
}
.wp-workers-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.wp-worker-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: var(--fs-sm);
}
.wp-worker-name { color: var(--color-text-primary); font-family: var(--font-mono); }
.wp-worker-load { color: var(--color-text-muted); font-family: var(--font-mono); font-size: 0.8rem; }

.wp-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.9rem;
  padding-top: 0.7rem;
  border-top: 1px solid var(--color-border-subtle);
}
.wp-actions .btn-secondary { font-size: var(--fs-sm); padding: 0.35rem 0.7rem; }
.wp-action-failed { border-color: #ef4444; color: #ef4444; }
.wp-action-failed:hover:not([disabled]) { background: rgba(239, 68, 68, 0.08); }
.wp-action-stale { border-color: #f59e0b; color: #f59e0b; }
.wp-action-stale:hover:not([disabled]) { background: rgba(245, 158, 11, 0.08); }
.wp-actions .btn-secondary[disabled] { opacity: 0.55; cursor: progress; }

.wp-error {
  margin-top: 0.6rem;
  font-size: var(--fs-sm);
  color: #ef4444;
  font-family: var(--font-mono);
}

.scan-status-row {
  padding: 0.9rem 1.1rem 0.9rem;
}
.scan-line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.4rem;
  font-size: var(--fs-sm);
}
.scan-icon { font-size: 1rem; line-height: 1; }
.scan-text { color: var(--color-text-secondary); }
.scan-progress { color: var(--color-text-primary); font-family: var(--font-mono); margin-left: 0.2rem; }
.scan-line-idle .scan-icon { color: var(--color-text-muted); }
.scan-line-done .scan-icon { color: #10b981; }
.scan-line-failed .scan-icon { color: #ef4444; }
.scan-line-failed .scan-text, .scan-line-failed .scan-err { color: #ef4444; }
.scan-spinner {
  display: inline-block;
  width: 0.85rem;
  height: 0.85rem;
  border: 2px solid var(--color-border-subtle);
  border-top-color: var(--color-accent-primary, #6366f1);
  border-radius: 50%;
  animation: scan-spin 0.85s linear infinite;
}
@keyframes scan-spin { to { transform: rotate(360deg); } }
.scan-err-line {
  margin-top: 0.4rem;
  font-size: var(--fs-sm);
  color: #ef4444;
  font-family: var(--font-mono);
}

/* P2 — Worker toggle + last error */
.wp-worker-toggle {
  margin-top: 0.7rem;
  padding-top: 0.6rem;
  border-top: 1px dashed var(--color-border-subtle);
}
.wp-toggle-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}
.wp-toggle-text {
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
}
.wp-toggle-on { color: #10b981; }
.wp-toggle-off { color: var(--color-text-muted); }
.wp-last-error {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: rgba(239, 68, 68, 0.07);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-left: 3px solid #ef4444;
}
.wp-last-error-icon { color: #ef4444; flex-shrink: 0; }
.wp-last-error-label {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  flex-shrink: 0;
  margin-top: 0.05rem;
}
.wp-last-error-msg {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: #ef4444;
  word-break: break-all;
}

/* P3 — recent albums skeleton */
.recent-skeleton { padding: 0.4rem 0; }

.activity-toast {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 200;
  padding: 0.7rem 1rem;
  background: var(--color-surface-strong, #16161a);
  border: 1px solid var(--color-border-strong, var(--color-text-muted));
  border-left: 3px solid var(--color-accent-primary, #6366f1);
  color: var(--color-text-primary);
  font-size: var(--fs-sm);
  max-width: 24rem;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.dashboard-toast-enter-active, .dashboard-toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.dashboard-toast-enter-from, .dashboard-toast-leave-to { opacity: 0; transform: translateY(0.5rem); }

@media (max-width: 720px) {
  .wp-counts { grid-template-columns: repeat(2, 1fr); }
}

/* ── 101: Storage section ─────────────────────────────────────────── */
.storage-section { margin-bottom: 2rem; }
.storage-panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
@media (max-width: 720px) { .storage-panels { grid-template-columns: 1fr; } }

.storage-loading { padding: 1rem; color: var(--color-text-muted); font-size: 0.85rem; }
.storage-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.storage-table th {
  text-align: left; padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-muted); font-weight: 600; font-size: 0.75rem;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.storage-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--color-border-subtle, var(--color-border)); }
.storage-table tfoot td { border-top: 2px solid var(--color-border); border-bottom: none; padding-top: 0.5rem; }
.num-col { text-align: right; font-variant-numeric: tabular-nums; }
.type-cell { font-family: monospace; font-size: 0.8rem; }
.cover-row td { color: var(--color-text-muted); font-style: italic; }
.muted { color: var(--color-text-muted); }

.cost-rows { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.25rem 0; }
.cost-row { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; font-size: 0.875rem; }
.cost-row-input { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
.cost-label { color: var(--color-text-muted); white-space: nowrap; }
.cost-value { font-variant-numeric: tabular-nums; font-weight: 500; }
.cost-zero { color: var(--color-text-muted); }
.cost-total-row { border-top: 1px solid var(--color-border); padding-top: 0.5rem; margin-top: 0.25rem; }
.cost-total { font-size: 1.1rem; font-weight: 700; color: var(--color-accent, var(--color-primary)); }
.free-alloc-input-row { display: flex; align-items: center; gap: 0.4rem; }
.free-alloc-input {
  width: 5rem; padding: 0.25rem 0.4rem;
  border: 1px solid var(--color-border); border-radius: 4px;
  background: var(--color-bg-input, var(--color-bg)); color: var(--color-text);
  font-size: 0.875rem;
}
.cost-unit { color: var(--color-text-muted); font-size: 0.85rem; }
.cost-hint { font-size: 0.78rem; line-height: 1.4; }
.cost-pricing-note { font-size: 0.78rem; line-height: 1.4; border-top: 1px solid var(--color-border); padding-top: 0.5rem; margin-top: 0.25rem; }
</style>
