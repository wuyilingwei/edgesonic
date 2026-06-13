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
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";

const { t } = useI18n();
const { isLoggedIn, username, isAdmin, isSuperAdmin, level, authFetch, storageFetch, edgesonicFetch } = useAuth();
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

    <!-- 080 — Cron missing warning. Only super-admins see this; for everyone
         else cronStatus.value stays "ok" or never resolves and the banner
         never renders. Two render modes (empty / unconfigured) share the
         same card chrome so the layout stays consistent. -->
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
</style>
