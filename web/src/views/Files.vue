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
import { useAuth } from "../api";

const { authFetch } = useAuth();
const files = ref<Array<{ id: string; title: string; artist: string; album: string; suffix: string; duration: string }>>([]);
const artists = ref<Array<{ id: string; name: string }>>([]);
const albums = ref<Array<{ id: string; name: string }>>([]);
const currentArtist = ref("");
const currentAlbum = ref("");

async function loadArtists() {
  const xml = await authFetch("getArtists");
  const items: typeof artists.value = [];
  const re = /<artist\s+([^>]+)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    items.push({ id: m[1].match(/id="([^"]+)"/)?.[1] || "", name: m[1].match(/name="([^"]+)"/)?.[1] || "" });
  }
  artists.value = items;
}

async function selectArtist(id: string) {
  currentArtist.value = id;
  currentAlbum.value = "";
  const xml = await authFetch("getArtist", { id });
  const items: typeof albums.value = [];
  const re = /<album\s+([^>]+)\/>/g;
  let m;
  while ((m = re.exec(xml))) items.push({ id: m[1].match(/id="([^"]+)"/)?.[1] || "", name: m[1].match(/name="([^"]+)"/)?.[1] || "" });
  albums.value = items;
}

async function selectAlbum(id: string) {
  currentAlbum.value = id;
  const xml = await authFetch("getAlbum", { id });
  const items: typeof files.value = [];
  const re = /<song\s+([^>]+)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    items.push({
      id: m[1].match(/id="([^"]+)"/)?.[1] || "",
      title: m[1].match(/title="([^"]+)"/)?.[1] || "",
      artist: m[1].match(/artist="([^"]+)"/)?.[1] || "",
      album: m[1].match(/album="([^"]+)"/)?.[1] || "",
      suffix: m[1].match(/suffix="([^"]+)"/)?.[1] || "",
      duration: m[1].match(/duration="(\d+)"/)?.[1] || "",
    });
  }
  files.value = items;
}

function formatDuration(s: string) {
  const sec = parseInt(s, 10);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

onMounted(loadArtists);
</script>

<template>
  <div>
    <h1 style="margin-bottom:16px">File Browser</h1>
    <div class="browser">
      <div class="col artists">
        <h3>Artists</h3>
        <div v-for="a in artists" :key="a.id" :class="{ active: currentArtist === a.id }" @click="selectArtist(a.id)">{{ a.name }}</div>
      </div>
      <div class="col albums" v-if="currentArtist">
        <h3>Albums</h3>
        <div v-for="a in albums" :key="a.id" :class="{ active: currentAlbum === a.id }" @click="selectAlbum(a.id)">{{ a.name }}</div>
      </div>
      <div class="col songs" v-if="currentAlbum">
        <h3>Songs</h3>
        <div v-for="f in files" :key="f.id" class="song-row">
          <span>{{ f.title }}</span>
          <span class="meta">{{ f.suffix }} · {{ formatDuration(f.duration) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser { display: flex; gap: 16px; }
.col { flex: 1; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; max-height: 60vh; overflow-y: auto; }
.col h3 { font-size: 13px; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; }
.col div { padding: 6px 8px; cursor: pointer; border-radius: 4px; font-size: 13px; }
.col div:hover { background: #21262d; }
.col div.active { background: #1f6feb22; color: #58a6ff; }
.song-row { display: flex; justify-content: space-between; }
.meta { color: #8b949e; font-size: 12px; }
</style>
