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
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";

const { t } = useI18n();
const { isLoggedIn, username, isAdmin, isSuperAdmin, level, authFetch, storageFetch, edgesonicFetch, edgesonicPost } = useAuth();
const stats = ref({ artists: 0, albums: 0, songs: 0, sources: 0, users: 0 });
const recentAlbums = ref<Array<{ id: string; name: string; artist: string; year: string }>>([]);

// 080 — Cron warning state. Three modes:
//   "ok"            — schedules present (no banner)
//   "empty"         — CF responded ok with schedules=[] (the bug we warn about)
//   "unconfigured"  — CF_API_TOKEN/CF_ACCOUNT_ID missing (info, not error)
//   "error"         — getCron returned an unexpected failure; we stay quiet
//                     here because the Dashboard isn't the place to surface
//                     CF upstream errors (Settings does that).
//   "checking"      — initial state before the request resolves
type CronStatus = "checking" | "ok" | "empty" | "unconfigured" | "error";
const cronStatus = ref<CronStatus>("checking");

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };

// 083 — Super-admin "System Activity" panel: work-pool card + scan status row.
// Both refresh on a 30s timer (paused while the tab is hidden) so an admin
// just sitting on the Dashboard sees a live signal of how the metadata
// pipeline is doing without needing to bounce to Files / Settings.
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
const POLL_INTERVAL_MS = 30_000;

// Denominator for "metadata progress": everything except canceled (the user
// cancelled it, it's not "work in flight" anymore). We don't divide by
// counts.canceled so a one-off cancel doesn't drag the % down forever.
const totalTasks = computed(() => workCounts.value.queued + workCounts.value.claimed + workCounts.value.completed + workCounts.value.failed);
const progressPct = computed(() => {
  const total = totalTasks.value;
  if (total === 0) return 0;
  return Math.min(100, Math.round((workCounts.value.completed / total) * 1000) / 10);
});
// Latest scan job: prefer endedAt desc (so we surface the most recent finished
// scan), fall back to startedAt for in-flight ones.
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
    scanError.value = e instanceof Error ? e.message : String(e);
  }
}

async function refreshActivity() {
  await Promise.all([loadWorkStatus(), loadScanStatus()]);
}

function startActivityPolling() {
  if (!isSuperAdmin.value) return;
  if (activityTimer !== null) return;
  activityTimer = window.setInterval(() => { void refreshActivity(); }, POLL_INTERVAL_MS);
}

function stopActivityPolling() {
  if (activityTimer !== null) {
    window.clearInterval(activityTimer);
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
    const [artistXml, albumListXml, sourceXml, userXml] = await Promise.all([
      authFetch("getArtists"),
      authFetch("getAlbumList2", { type: "newest", size: "6" }),
      isAdmin.value ? storageFetch("sources/list") : Promise.resolve(""),
      isAdmin.value ? edgesonicFetch("users/list") : Promise.resolve(""),
    ]);

    stats.value.artists = artistXml.match(/<artist\s/g)?.length || 0;

    const albums = parseXmlAttrs(albumListXml, "album");
    stats.value.albums = albums.length;
    recentAlbums.value = albums.map((a) => ({
      id: a.id || "", name: a.name || a.title || "", artist: a.artist || "", year: a.year || "",
    }));

    if (sourceXml) {
      stats.value.sources = parseXmlAttrs(sourceXml, "source").length;
    }
    // 072 — /edgesonic/users/list is now JSON; older XML path stayed only
    // because Dashboard used parseXmlAttrs to count rows. JSON.parse-and-count
    // here mirrors the new Users.vue load().
    if (userXml) {
      try {
        const parsed = JSON.parse(userXml) as { ok?: boolean; users?: unknown[] };
        if (parsed.ok && Array.isArray(parsed.users)) stats.value.users = parsed.users.length;
      } catch { /* leave stats.users at 0 on parse failure */ }
    }

    // Count songs from album details
    let songCount = 0;
    for (const album of recentAlbums.value.slice(0, 3)) {
      const albumXml = await authFetch("getAlbum", { id: album.id });
      songCount += (albumXml.match(/<song\s/g) || []).length;
    }
    stats.value.songs = songCount;
  } catch {}

  // 080 — super-admin only: read CF schedules and decide whether to show the
  // "cron missing" banner. We do this AFTER the main stats so the banner
  // can't block the dashboard if CF API is slow. Errors are swallowed (the
  // banner just doesn't appear) because Settings → CF is the canonical place
  // to debug CF API issues.
  if (isSuperAdmin.value) {
    try {
      const text = await edgesonicFetch("cf/getCron");
      const parsed = JSON.parse(text) as { ok?: boolean; schedules?: Array<{ cron: string }>; error?: string };
      if (parsed.ok === true) {
        const schedules = Array.isArray(parsed.schedules) ? parsed.schedules : [];
        cronStatus.value = schedules.length === 0 ? "empty" : "ok";
      } else if (typeof parsed.error === "string" && /CF_API_TOKEN|CF_ACCOUNT_ID|not configured/i.test(parsed.error)) {
        // 054 returns 400 with this wording when env secrets are missing.
        cronStatus.value = "unconfigured";
      } else {
        cronStatus.value = "error";
      }
    } catch {
      cronStatus.value = "error";
    }
  } else {
    cronStatus.value = "ok";
  }

  // 083 — kick off the activity panel after cron status resolves so the
  // initial paint isn't blocked by two extra round-trips. Polling is
  // intentionally super-admin only (the endpoints also gate at level≥3) —
  // for everyone else the panel is hidden via v-if.
  if (isSuperAdmin.value) {
    void refreshActivity();
    startActivityPolling();
    document.addEventListener("visibilitychange", onActivityVisibility);
  }
});

onUnmounted(() => {
  stopActivityPolling();
  document.removeEventListener("visibilitychange", onActivityVisibility);
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

    <!-- 083 — System Activity (super-admin only). Sits BEFORE stats because it's
         actionable (failed tasks, stale claims) while the stats cards are
         informational. The 080 cron warning lives inside this section so all
         operational signals cluster instead of stacking down the page. -->
    <section v-if="isSuperAdmin" class="system-activity">
      <div class="page-section-header">
        <span class="mono-label">{{ t("dashboard.systemActivity.label") }}</span>
      </div>

      <!-- 080 — Cron missing warning. Two render modes (empty / unconfigured)
           share the same card chrome so the layout stays consistent. -->
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

      <!-- Work pool card -->
      <div
        class="card work-pool-card"
        :class="{
          'work-pool-failed': workCounts.failed > 0,
          'work-pool-warning': workCounts.failed === 0 && workCounts.claimed > 0,
        }"
      >
        <div class="card-header">
          <span class="card-title">{{ t("dashboard.workPool.title") }}</span>
          <button class="wp-refresh" :title="t('dashboard.workPool.refresh')" @click="refreshActivity()">↻</button>
        </div>

        <div class="wp-progress-line">
          <span class="wp-progress-label">{{ t("dashboard.workPool.progress") }}</span>
          <span class="wp-progress-num">{{ workCounts.completed }} / {{ totalTasks }} ({{ progressPct }}%)</span>
        </div>
        <div class="wp-progress-bar">
          <div class="wp-progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>

        <div class="wp-counts">
          <div class="wp-count wp-count-queued">
            <span class="wp-count-icon">⏳</span>
            <span class="wp-count-label">{{ t("dashboard.workPool.queued") }}</span>
            <span class="wp-count-num">{{ workCounts.queued }}</span>
          </div>
          <div class="wp-count wp-count-claimed">
            <span class="wp-count-icon">🔄</span>
            <span class="wp-count-label">{{ t("dashboard.workPool.claimed") }}</span>
            <span class="wp-count-num">{{ workCounts.claimed }}</span>
          </div>
          <div class="wp-count wp-count-completed">
            <span class="wp-count-icon">✓</span>
            <span class="wp-count-label">{{ t("dashboard.workPool.completed") }}</span>
            <span class="wp-count-num">{{ workCounts.completed }}</span>
          </div>
          <div class="wp-count wp-count-failed" :class="{ 'wp-count-emphasis': workCounts.failed > 0 }">
            <span class="wp-count-icon">✕</span>
            <span class="wp-count-label">{{ t("dashboard.workPool.failed") }}</span>
            <span class="wp-count-num">{{ workCounts.failed }}</span>
          </div>
        </div>

        <div class="wp-workers">
          <div class="wp-workers-title">{{ t("dashboard.workPool.activeWorkers") }}</div>
          <div v-if="workLoad.length === 0" class="wp-workers-empty">{{ t("dashboard.workPool.noActive") }}</div>
          <ul v-else class="wp-workers-list">
            <li v-for="row in workLoad" :key="row.username" class="wp-worker-row">
              <span class="wp-worker-name">{{ row.username }}</span>
              <span class="wp-worker-load">{{ t("dashboard.workPool.workerLoad", { n: row.n }) }}</span>
            </li>
          </ul>
        </div>

        <div v-if="workCounts.failed > 0 || workCounts.claimed > 0" class="wp-actions">
          <button
            v-if="workCounts.failed > 0"
            class="btn-secondary wp-action-failed"
            :disabled="resetFailedBusy"
            @click="onResetFailedWork()"
          >
            {{ resetFailedBusy ? t("settings.common.maintenance.resetFailedRunning") : t("dashboard.workPool.resetFailedBtn") }}
          </button>
          <button
            v-if="workCounts.claimed > 0"
            class="btn-secondary wp-action-stale"
            :disabled="reclaimBusy"
            @click="onReclaimStaleWork()"
          >
            {{ reclaimBusy ? t("settings.common.maintenance.reclaimRunning") : t("dashboard.workPool.reclaimStaleBtn") }}
          </button>
        </div>

        <div v-if="workError" class="wp-error">{{ t("dashboard.workPool.loadFailed") }} — {{ workError }}</div>
      </div>

      <!-- Scan status row -->
      <div class="card scan-status-row">
        <div class="card-header">
          <span class="card-title">{{ t("dashboard.scanStatus.sectionTitle") }}</span>
        </div>
        <div v-if="!latestScan" class="scan-line scan-line-idle">
          <span class="scan-icon">◌</span>
          <span class="scan-text">{{ t("dashboard.scanStatus.noScans") }}</span>
        </div>
        <div v-else-if="latestScan.status === 'running'" class="scan-line scan-line-running">
          <span class="scan-spinner"></span>
          <span class="scan-text">
            {{ t("dashboard.scanStatus.scanning") }}
            <span v-if="latestScan.total > 0" class="scan-progress">
              ({{ latestScan.scanned }} / {{ latestScan.total }})
            </span>
            <span v-else class="scan-progress">({{ latestScan.scanned }})</span>
          </span>
        </div>
        <div v-else-if="latestScan.status === 'failed'" class="scan-line scan-line-failed">
          <span class="scan-icon">✕</span>
          <span class="scan-text">
            {{ t("dashboard.scanStatus.failed") }}
            <span v-if="latestScan.error" class="scan-err">— {{ latestScan.error }}</span>
          </span>
        </div>
        <div v-else class="scan-line scan-line-done">
          <span class="scan-icon">✓</span>
          <span class="scan-text">
            {{ t("dashboard.scanStatus.lastScan", { ago: relativeTime(latestScan.endedAt ?? latestScan.startedAt) }) }}
            · {{ t("dashboard.scanStatus.lastScanCount", { n: latestScan.scanned }) }}
          </span>
        </div>
        <div v-if="scanError" class="scan-err-line">{{ t("dashboard.scanStatus.loadFailed") }} — {{ scanError }}</div>
      </div>

      <transition name="dashboard-toast">
        <div v-if="activityToast" class="activity-toast">{{ activityToast }}</div>
      </transition>
    </section>

    <!-- Stats -->
    <div class="grid grid-4 stats-grid">
      <div class="stat-card card hoverable">
        <div class="stat-num">{{ stats.artists }}</div>
        <div class="mono-label">{{ t("dashboard.artists") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
      <div class="stat-card card hoverable">
        <div class="stat-num">{{ stats.albums }}</div>
        <div class="mono-label">{{ t("dashboard.albums") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
      <div class="stat-card card hoverable">
        <div class="stat-num">{{ stats.songs }}</div>
        <div class="mono-label">{{ t("dashboard.songs") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
      <div v-if="isAdmin" class="stat-card card hoverable">
        <div class="stat-num">{{ stats.sources }}</div>
        <div class="mono-label">{{ t("dashboard.storageSources") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
      <div v-else class="stat-card card hoverable">
        <div class="stat-num">–</div>
        <div class="mono-label">{{ t("dashboard.online") }}</div>
        <div class="corner corner-tr"></div><div class="corner corner-bl"></div>
      </div>
    </div>

    <!-- Admin Quick Info -->
    <div v-if="isAdmin" class="grid grid-2" style="margin-top: 1rem">
      <div class="card">
        <div class="card-header">
          <span class="card-title">{{ t("dashboard.recentAlbums") }}</span>
        </div>
        <div v-if="recentAlbums.length" class="recent-table" style="--grid-cols: 2fr 1fr auto">
          <div class="table-header"><span>{{ t("dashboard.colName") }}</span><span>{{ t("dashboard.colArtist") }}</span><span>{{ t("dashboard.colYear") }}</span></div>
          <div v-for="a in recentAlbums" :key="a.id" class="table-row">
            <span class="row-name">{{ a.name }}</span>
            <span class="row-sub">{{ a.artist }}</span>
            <span class="row-mono">{{ a.year }}</span>
          </div>
        </div>
        <div v-else class="empty-state">
          <div class="empty-state-icon">◌</div>
          <div>{{ t("dashboard.noAlbums") }}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">{{ t("dashboard.systemInfo") }}</span>
        </div>
        <div class="info-list">
          <div class="info-row"><span class="info-key">{{ t("dashboard.infoUsers") }}</span><span class="info-val">{{ stats.users }}</span></div>
          <div class="info-row"><span class="info-key">{{ t("dashboard.infoSources") }}</span><span class="info-val">{{ stats.sources }}</span></div>
          <div class="info-row"><span class="info-key">{{ t("dashboard.infoApiVersion") }}</span><span class="info-val">1.16.1</span></div>
          <div class="info-row"><span class="info-key">{{ t("dashboard.infoPlatform") }}</span><span class="info-val">Cloudflare Workers</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard { max-width: 1200px; }
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
.info-row {
  display: flex; justify-content: space-between;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--color-border-subtle);
}
.info-row:last-child { border-bottom: none; }
.info-key { font-family: var(--font-mono); font-size: var(--fs-sm); letter-spacing: 0.1em; color: var(--color-text-muted); }
.info-val { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-primary); }

/* 080 — Cron warning banner. Orange/amber accent for the "empty schedules"
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

/* 083 — System activity (super-admin only). Sits above the 4 stat cards;
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
</style>
