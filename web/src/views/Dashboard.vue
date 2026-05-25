<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAuth } from "../api";

const { isLoggedIn, username, isAdmin } = useAuth();
const stats = ref({ artists: 0, albums: 0, songs: 0, sources: 0 });

onMounted(async () => {
  if (!isLoggedIn.value) return;
  try {
    // Fetch stats from API
  } catch {}
});
</script>

<template>
  <div>
    <h1 style="margin-bottom:20px">Dashboard</h1>
    <p v-if="!isLoggedIn">Please sign in.</p>
    <template v-else>
      <div class="header-bar">
        <span>Welcome, {{ username }} <span v-if="isAdmin" class="badge">Admin</span></span>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="num">{{ stats.artists }}</div><div class="label">Artists</div></div>
        <div class="stat-card"><div class="num">{{ stats.albums }}</div><div class="label">Albums</div></div>
        <div class="stat-card"><div class="num">{{ stats.songs }}</div><div class="label">Songs</div></div>
        <div class="stat-card"><div class="num">{{ stats.sources }}</div><div class="label">Sources</div></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.header-bar { padding: 12px 0; margin-bottom: 20px; font-size: 14px; color: #8b949e; }
.badge { background: #1f6feb22; color: #58a6ff; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-left: 8px; }
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; text-align: center; }
.stat-card .num { font-size: 32px; font-weight: 700; color: #58a6ff; }
.stat-card .label { font-size: 13px; color: #8b949e; margin-top: 4px; }
</style>
