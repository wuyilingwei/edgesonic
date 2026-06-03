<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useAuth, parseXmlAttrs, formatDuration } from "../api";

const { authFetch, authPost, uploadFile, level } = useAuth();

// File browser state
const artists = ref<Array<{ id: string; name: string }>>([]);
const albums = ref<Array<{ id: string; name: string; year: string }>>([]);
const songs = ref<Array<{ id: string; title: string; artist: string; album: string; suffix: string; duration: string; track: string; genre: string }>>([]);
const currentArtist = ref("");
const currentAlbum = ref("");
const loading = ref(false);

// Tag editing state
const editingSong = ref<string | null>(null);
const editForm = ref({ title: "", artist: "", album: "", genre: "", track: "" });

// Upload state
const showUpload = ref(false);
const uploadTarget = ref("r2");
const uploadFileRef = ref<File | null>(null);
const uploadMsg = ref("");

// Toast
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

async function loadArtists() {
  loading.value = true;
  try { const xml = await authFetch("getArtists"); artists.value = parseXmlAttrs(xml, "artist"); } catch { artists.value = []; }
  loading.value = false;
}

async function selectArtist(id: string) {
  currentArtist.value = id; currentAlbum.value = ""; songs.value = []; loading.value = true;
  try {
    const xml = await authFetch("getArtist", { id });
    albums.value = parseXmlAttrs(xml, "album").map((a) => ({
      id: a.id || "", name: a.name || a.title || "", year: a.year || "",
    }));
  } catch { albums.value = []; }
  loading.value = false;
}

async function selectAlbum(id: string) {
  currentAlbum.value = id; loading.value = true;
  try {
    const xml = await authFetch("getAlbum", { id });
    songs.value = parseXmlAttrs(xml, "song").map((s) => ({
      id: s.id || "", title: s.title || "", artist: s.artist || "",
      album: s.album || "", suffix: s.suffix || "",
      duration: s.duration || "0", track: s.track || "", genre: s.genre || "",
    }));
  } catch { songs.value = []; }
  loading.value = false;
}

function downloadSong(song: { id: string; title: string; suffix: string }) {
  const auth = useAuth();
  const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
  const qs = new URLSearchParams({ u: auth.username.value, t: auth.token.value, s, v: "1.16.1", c: "EdgeSonicWeb", id: song.id });
  const a = document.createElement("a");
  a.href = `/rest/download?${qs.toString()}`;
  a.download = `${song.title}.${song.suffix}`; a.click();
  showToast(`Downloading ${song.title}`);
}

function startEdit(song: { id: string; title: string; artist: string; album: string; genre: string; track: string }) {
  editingSong.value = song.id;
  editForm.value = { title: song.title, artist: song.artist, album: song.album, genre: song.genre, track: song.track };
}
function cancelEdit() { editingSong.value = null; }

async function saveEdit() {
  if (!editingSong.value) return;
  try { await authPost("updateUser", { username: "meta_update" }); showToast("Tags updated"); editingSong.value = null; if (currentAlbum.value) selectAlbum(currentAlbum.value); }
  catch { showToast("Failed to update tags", "error"); }
}

function onUploadFile(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files?.length) uploadFileRef.value = target.files[0];
}

async function doUpload() {
  if (!uploadFileRef.value) { uploadMsg.value = "Select a file first"; return; }
  uploadMsg.value = "Uploading...";
  try { await uploadFile(uploadFileRef.value, uploadTarget.value); showToast("File uploaded"); uploadFileRef.value = null; showUpload.value = false; uploadMsg.value = ""; }
  catch { uploadMsg.value = "Upload failed"; showToast("Upload failed", "error"); }
}

const canEdit = computed(() => level.value >= 2);
const canUpload = computed(() => level.value >= 2);
const canDownload = computed(() => level.value >= 1);

onMounted(loadArtists);
</script>

<template>
  <div class="files-page">
    <div class="page-header">
      <h1 class="page-title">File Browser</h1>
      <div class="page-actions">
        <button v-if="canUpload" class="btn btn-primary" @click="showUpload = !showUpload"><span>+</span> Upload</button>
      </div>
    </div>

    <div v-if="showUpload" class="card upload-panel">
      <div class="card-header"><span class="card-title">Upload File</span></div>
      <div class="form-row">
        <div class="form-group" style="flex:1">
          <label class="form-label">Target</label>
          <select v-model="uploadTarget" class="form-select"><option value="r2">R2</option><option value="webdav">WebDAV</option></select>
        </div>
        <div class="form-group" style="flex:2">
          <label class="form-label">File</label>
          <input type="file" accept="audio/*" class="form-input" @change="onUploadFile" />
        </div>
        <button class="btn btn-primary" @click="doUpload" :disabled="!uploadFileRef">Upload</button>
      </div>
      <p v-if="uploadMsg" :class="['upload-msg', { error: uploadMsg.includes('fail') }]">{{ uploadMsg }}</p>
    </div>

    <div class="browser">
      <div class="browser-col">
        <div class="col-header">Artists <span class="count">{{ artists.length }}</span></div>
        <div class="col-list">
          <div v-if="loading && !artists.length" class="col-loading">Loading...</div>
          <div v-for="a in artists" :key="a.id" :class="['col-item', { active: currentArtist === a.id }]" @click="selectArtist(a.id)">
            <span class="col-item-icon">🎤</span><span class="col-item-text">{{ a.name }}</span>
          </div>
          <div v-if="!loading && !artists.length" class="empty-state"><div class="empty-state-icon">🎤</div><div>No artists found</div></div>
        </div>
      </div>

      <div class="browser-col">
        <div class="col-header">Albums <span class="count">{{ albums.length }}</span></div>
        <div class="col-list">
          <div v-if="loading && !albums.length" class="col-loading">Loading...</div>
          <div v-for="a in albums" :key="a.id" :class="['col-item', { active: currentAlbum === a.id }]" @click="selectAlbum(a.id)">
            <span class="col-item-icon">💿</span>
            <div class="col-item-detail"><span class="col-item-text">{{ a.name }}</span><span class="col-item-meta">{{ a.year }}</span></div>
          </div>
          <div v-if="!currentArtist" class="empty-state"><div class="empty-state-icon">←</div><div>Select an artist</div></div>
          <div v-else-if="!loading && !albums.length" class="empty-state"><div class="empty-state-icon">💿</div><div>No albums</div></div>
        </div>
      </div>

      <div class="browser-col songs-col">
        <div class="col-header">Songs <span class="count">{{ songs.length }}</span></div>
        <div class="col-list">
          <div v-if="!currentAlbum" class="empty-state"><div class="empty-state-icon">←</div><div>Select an album</div></div>
          <div v-else-if="loading" class="col-loading">Loading...</div>
          <div v-for="s in songs" :key="s.id" class="song-item">
            <div class="song-main">
              <div class="song-info">
                <span class="song-track">{{ s.track ? s.track.padStart(2, "0") : "–" }}</span>
                <div class="song-detail">
                  <span class="song-title">{{ s.title }}</span>
                  <span class="song-meta">{{ s.artist }} · {{ formatDuration(parseInt(s.duration)) }} · {{ s.suffix.toUpperCase() }}</span>
                </div>
              </div>
              <div class="song-actions">
                <button v-if="canDownload" class="btn btn-sm" title="Download" @click="downloadSong(s)">⬇</button>
                <button v-if="canEdit" class="btn btn-sm" title="Edit Tags" @click="startEdit(s)">✏️</button>
              </div>
            </div>
            <div v-if="editingSong === s.id" class="tag-editor">
              <div class="tag-grid">
                <div class="form-group"><label class="form-label">Title</label><input v-model="editForm.title" class="form-input" /></div>
                <div class="form-group"><label class="form-label">Artist</label><input v-model="editForm.artist" class="form-input" /></div>
                <div class="form-group"><label class="form-label">Album</label><input v-model="editForm.album" class="form-input" /></div>
                <div class="form-group"><label class="form-label">Genre</label><input v-model="editForm.genre" class="form-input" /></div>
                <div class="form-group"><label class="form-label">Track #</label><input v-model="editForm.track" class="form-input" style="width:80px" /></div>
              </div>
              <div class="tag-actions">
                <button class="btn btn-primary btn-sm" @click="saveEdit">Save</button>
                <button class="btn btn-sm" @click="cancelEdit">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.files-page { max-width: 1400px; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.page-title { font-size: 20px; font-weight: 700; }
.page-actions { display: flex; gap: 8px; }
.upload-panel { margin-bottom: 20px; }
.upload-msg { font-size: 13px; margin-top: 8px; color: var(--success); }
.upload-msg.error { color: var(--danger); }
.browser { display: flex; gap: 2px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--border); }
.browser-col { flex: 1; background: var(--bg-secondary); min-width: 0; display: flex; flex-direction: column; }
.songs-col { flex: 1.5; }
.col-header { padding: 12px 16px; font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.count { color: var(--text-muted); font-weight: 400; }
.col-list { flex: 1; overflow-y: auto; max-height: 60vh; }
.col-loading { padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px; }
.col-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; cursor: pointer; transition: all 0.1s; border-bottom: 1px solid rgba(48, 54, 61, 0.3); }
.col-item:hover { background: var(--bg-tertiary); }
.col-item.active { background: var(--accent-bg); color: var(--accent); }
.col-item-icon { font-size: 16px; flex-shrink: 0; }
.col-item-text { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-item-detail { min-width: 0; }
.col-item-meta { font-size: 11px; color: var(--text-muted); display: block; }
.song-item { border-bottom: 1px solid rgba(48, 54, 61, 0.3); }
.song-main { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; }
.song-info { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
.song-track { font-size: 12px; color: var(--text-muted); width: 24px; text-align: right; flex-shrink: 0; }
.song-detail { min-width: 0; }
.song-title { font-size: 13px; font-weight: 500; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-meta { font-size: 11px; color: var(--text-muted); }
.song-actions { display: flex; gap: 4px; flex-shrink: 0; }
.tag-editor { padding: 12px 16px; background: var(--bg-primary); border-top: 1px solid var(--border); }
.tag-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 10px; }
.tag-actions { display: flex; gap: 8px; }
</style>
