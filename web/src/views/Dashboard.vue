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
const { isLoggedIn, username, isAdmin, level, authFetch } = useAuth();
const stats = ref({ artists: 0, albums: 0, songs: 0, sources: 0, users: 0 });
const recentAlbums = ref<Array<{ id: string; name: string; artist: string; year: string }>>([]);

const levelKeys: Record<number, string> = { 0: "guest", 1: "user", 2: "admin", 3: "super" };

onMounted(async () => {
  if (!isLoggedIn.value) return;
  try {
    const [artistXml, albumListXml, sourceXml, userXml] = await Promise.all([
      authFetch("getArtists"),
      authFetch("getAlbumList2", { type: "newest", size: "6" }),
      isAdmin.value ? authFetch("getStorageSources") : Promise.resolve(""),
      isAdmin.value ? authFetch("getUsers") : Promise.resolve(""),
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
    if (userXml) {
      stats.value.users = parseXmlAttrs(userXml, "user").length;
    }

    // Count songs from album details
    let songCount = 0;
    for (const album of recentAlbums.value.slice(0, 3)) {
      const albumXml = await authFetch("getAlbum", { id: album.id });
      songCount += (albumXml.match(/<song\s/g) || []).length;
    }
    stats.value.songs = songCount;
  } catch {}
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
</style>
