<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAuth, parseXmlAttrs } from "../api";

const { isLoggedIn, username, isAdmin, isSuperAdmin, level, authFetch } = useAuth();
const stats = ref({ artists: 0, albums: 0, songs: 0, sources: 0, users: 0 });
const recentAlbums = ref<Array<{ id: string; name: string; artist: string; year: string }>>([]);

const levelLabels: Record<number, string> = { 0: "Guest", 1: "User", 2: "Admin", 3: "Super Admin" };

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
    <div class="welcome-card card">
      <div class="welcome-content">
        <h2>Welcome back, {{ username }}</h2>
        <p class="welcome-sub">
          <span :class="['badge', level >= 3 ? 'badge-yellow' : level >= 2 ? 'badge-blue' : 'badge-green']">
            {{ levelLabels[level] || "Unknown" }}
          </span>
          <span class="welcome-msg">You have access to the EdgeSonic management console.</span>
        </p>
      </div>
    </div>

    <!-- Stats -->
    <div class="grid grid-4 stats-grid">
      <div class="stat-card card">
        <div class="stat-icon">🎤</div>
        <div class="stat-num">{{ stats.artists }}</div>
        <div class="stat-label">Artists</div>
      </div>
      <div class="stat-card card">
        <div class="stat-icon">💿</div>
        <div class="stat-num">{{ stats.albums }}</div>
        <div class="stat-label">Albums</div>
      </div>
      <div class="stat-card card">
        <div class="stat-icon">🎵</div>
        <div class="stat-num">{{ stats.songs }}</div>
        <div class="stat-label">Songs</div>
      </div>
      <div v-if="isAdmin" class="stat-card card">
        <div class="stat-icon">☁️</div>
        <div class="stat-num">{{ stats.sources }}</div>
        <div class="stat-label">Storage Sources</div>
      </div>
      <div v-else class="stat-card card">
        <div class="stat-icon">👥</div>
        <div class="stat-num">–</div>
        <div class="stat-label">Online</div>
      </div>
    </div>

    <!-- Admin Quick Info -->
    <div v-if="isAdmin" class="grid grid-2" style="margin-top: 16px">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Recent Albums</span>
        </div>
        <table class="table" v-if="recentAlbums.length">
          <thead><tr><th>Name</th><th>Artist</th><th>Year</th></tr></thead>
          <tbody>
            <tr v-for="a in recentAlbums" :key="a.id">
              <td>{{ a.name }}</td>
              <td>{{ a.artist }}</td>
              <td>{{ a.year }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-state">
          <div class="empty-state-icon">💿</div>
          <div>No albums found. Add a storage source to start scanning.</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">System Info</span>
        </div>
        <div class="info-list">
          <div class="info-row"><span class="info-key">Users</span><span class="info-val">{{ stats.users }}</span></div>
          <div class="info-row"><span class="info-key">Sources</span><span class="info-val">{{ stats.sources }}</span></div>
          <div class="info-row"><span class="info-key">API Version</span><span class="info-val">1.16.1</span></div>
          <div class="info-row"><span class="info-key">Platform</span><span class="info-val">Cloudflare Workers</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard { max-width: 1200px; }
.welcome-card { margin-bottom: 20px; }
.welcome-content h2 { font-size: 20px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px; }
.welcome-sub { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-secondary); }

.stats-grid { margin-bottom: 20px; }
.stat-card { text-align: center; padding: 24px 16px; }
.stat-icon { font-size: 28px; margin-bottom: 8px; }
.stat-num { font-size: 36px; font-weight: 700; color: var(--accent); line-height: 1.2; }
.stat-label { font-size: 12px; color: var(--text-secondary); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }

.info-list { display: flex; flex-direction: column; }
.info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.info-row:last-child { border-bottom: none; }
.info-key { color: var(--text-secondary); }
.info-val { color: var(--text-primary); font-weight: 500; }
</style>
