<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, formatDuration } from "../api";

const { t } = useI18n();
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
const uploadErr = ref(false);

// Toast
const toast = ref({ show: false, msg: "", type: "success" });
function showToast(msg: string, type = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

async function loadArtists() {
  loading.value = true;
  try {
    const xml = await authFetch("getArtists");
    artists.value = parseXmlAttrs(xml, "artist").map((a) => ({ id: a.id || "", name: a.name || "" }));
  } catch { artists.value = []; }
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
  const { restUrl } = useAuth();
  const a = document.createElement("a");
  a.href = restUrl("download", { id: song.id });
  a.download = `${song.title}.${song.suffix}`; a.click();
  showToast(t("files.downloading", { title: song.title }));
}

function startEdit(song: { id: string; title: string; artist: string; album: string; genre: string; track: string }) {
  editingSong.value = song.id;
  editForm.value = { title: song.title, artist: song.artist, album: song.album, genre: song.genre, track: song.track };
}
function cancelEdit() { editingSong.value = null; }

async function saveEdit() {
  if (!editingSong.value) return;
  try { await authPost("updateUser", { username: "meta_update" }); showToast(t("files.tagsUpdated")); editingSong.value = null; if (currentAlbum.value) selectAlbum(currentAlbum.value); }
  catch { showToast(t("files.tagsFailed"), "error"); }
}

function onUploadFile(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files?.length) uploadFileRef.value = target.files[0];
}

async function doUpload() {
  if (!uploadFileRef.value) { uploadMsg.value = t("files.selectFileFirst"); uploadErr.value = true; return; }
  uploadMsg.value = t("files.uploading");
  uploadErr.value = false;
  try { await uploadFile(uploadFileRef.value, uploadTarget.value); showToast(t("files.uploaded")); uploadFileRef.value = null; showUpload.value = false; uploadMsg.value = ""; }
  catch { uploadMsg.value = t("files.uploadFailed"); uploadErr.value = true; showToast(t("files.uploadFailed"), "error"); }
}

const canEdit = computed(() => level.value >= 2);
const canUpload = computed(() => level.value >= 2);
const canDownload = computed(() => level.value >= 1);

onMounted(loadArtists);
</script>

<template>
  <div class="files-page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("files.label") }}</div>
        <h1 class="page-title">{{ t("files.title") }}</h1>
      </div>
      <div class="page-actions">
        <button v-if="canUpload" class="btn-primary" @click="showUpload = !showUpload">{{ t("files.upload") }}</button>
      </div>
    </div>

    <div v-if="showUpload" class="card upload-panel">
      <div class="card-header"><span class="card-title">{{ t("files.uploadFile") }}</span></div>
      <div class="form-row">
        <div class="form-group" style="flex:1">
          <label class="form-label">{{ t("files.target") }}</label>
          <select v-model="uploadTarget" class="form-select"><option value="r2">R2</option><option value="webdav">WebDAV</option></select>
        </div>
        <div class="form-group" style="flex:2">
          <label class="form-label">{{ t("files.file") }}</label>
          <input type="file" accept="audio/*" class="form-input" @change="onUploadFile" />
        </div>
        <button class="btn-primary" @click="doUpload" :disabled="!uploadFileRef">{{ t("files.uploadBtn") }}</button>
      </div>
      <p v-if="uploadMsg" :class="['upload-msg', { error: uploadErr }]">{{ uploadMsg }}</p>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <div class="browser">
      <div class="browser-col">
        <div class="col-header">{{ t("files.artists") }} <span class="count">{{ artists.length }}</span></div>
        <div class="col-list">
          <div v-if="loading && !artists.length" class="col-loading">{{ t("common.loading") }}</div>
          <div v-for="a in artists" :key="a.id" :class="['col-item', { active: currentArtist === a.id }]" @click="selectArtist(a.id)">
            <span class="col-item-text">{{ a.name }}</span>
          </div>
          <div v-if="!loading && !artists.length" class="empty-state">{{ t("files.noArtists") }}</div>
        </div>
      </div>

      <div class="browser-col">
        <div class="col-header">{{ t("files.albums") }} <span class="count">{{ albums.length }}</span></div>
        <div class="col-list">
          <div v-if="loading && !albums.length" class="col-loading">{{ t("common.loading") }}</div>
          <div v-for="a in albums" :key="a.id" :class="['col-item', { active: currentAlbum === a.id }]" @click="selectAlbum(a.id)">
            <div class="col-item-detail"><span class="col-item-text">{{ a.name }}</span><span class="col-item-meta">{{ a.year }}</span></div>
          </div>
          <div v-if="!currentArtist" class="empty-state">{{ t("files.selectArtist") }}</div>
          <div v-else-if="!loading && !albums.length" class="empty-state">{{ t("files.noAlbums") }}</div>
        </div>
      </div>

      <div class="browser-col songs-col">
        <div class="col-header">{{ t("files.songs") }} <span class="count">{{ songs.length }}</span></div>
        <div class="col-list">
          <div v-if="!currentAlbum" class="empty-state">{{ t("files.selectAlbum") }}</div>
          <div v-else-if="loading" class="col-loading">{{ t("common.loading") }}</div>
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
                <button v-if="canDownload" class="btn-secondary btn-sm" :title="t('files.download')" @click="downloadSong(s)">DL</button>
                <button v-if="canEdit" class="btn-secondary btn-sm" :title="t('files.editTags')" @click="startEdit(s)">TAG</button>
              </div>
            </div>
            <div v-if="editingSong === s.id" class="tag-editor">
              <div class="tag-grid">
                <div class="form-group"><label class="form-label">{{ t("files.tagTitle") }}</label><input v-model="editForm.title" class="form-input" /></div>
                <div class="form-group"><label class="form-label">{{ t("files.tagArtist") }}</label><input v-model="editForm.artist" class="form-input" /></div>
                <div class="form-group"><label class="form-label">{{ t("files.tagAlbum") }}</label><input v-model="editForm.album" class="form-input" /></div>
                <div class="form-group"><label class="form-label">{{ t("files.tagGenre") }}</label><input v-model="editForm.genre" class="form-input" /></div>
                <div class="form-group"><label class="form-label">{{ t("files.tagTrack") }}</label><input v-model="editForm.track" class="form-input" style="width:80px" /></div>
              </div>
              <div class="tag-actions">
                <button class="btn-primary btn-sm" @click="saveEdit">{{ t("common.save") }}</button>
                <button class="btn-secondary btn-sm" @click="cancelEdit">{{ t("common.cancel") }}</button>
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
.page-actions { display: flex; gap: 0.5rem; }
.upload-panel { margin-bottom: 1.25rem; }
.upload-msg { font-family: var(--font-mono); font-size: var(--fs-sm); margin-top: 0.5rem; color: var(--color-status-success); }
.upload-msg.error { color: var(--color-status-error); }

.browser {
  display: flex; gap: 1px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  overflow: hidden;
  background: var(--color-border-subtle);
}
.browser-col { flex: 1; background: var(--color-bg-secondary); min-width: 0; display: flex; flex-direction: column; }
.songs-col { flex: 1.5; }
.col-header {
  padding: 0.75rem 1rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-text-muted);
  letter-spacing: 0.1em;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
  display: flex; align-items: center; gap: 0.5rem;
}
.count { color: var(--color-text-secondary); }
.col-list { flex: 1; overflow-y: auto; max-height: 60vh; }
.col-loading {
  padding: 1.25rem; text-align: center;
  font-family: var(--font-mono); font-size: var(--fs-sm);
  color: var(--color-text-muted);
  animation: pulse 2s ease-in-out infinite;
}
.col-item {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.55rem 1rem;
  cursor: pointer; transition: all 0.1s;
  border-bottom: 1px solid var(--color-border-subtle);
  border-left: 2px solid transparent;
}
.col-item:hover { background: var(--color-bg-tertiary); }
.col-item.active { background: var(--color-accent-dim); color: var(--color-accent-primary); border-left-color: var(--color-accent-primary); }
.col-item-text { font-size: var(--fs-md); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-item-detail { min-width: 0; }
.col-item-meta { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); display: block; }

.song-item { border-bottom: 1px solid var(--color-border-subtle); }
.song-main { display: flex; align-items: center; justify-content: space-between; padding: 0.6rem 1rem; }
.song-info { display: flex; align-items: center; gap: 0.8rem; min-width: 0; flex: 1; }
.song-track { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-text-muted); width: 24px; text-align: right; flex-shrink: 0; }
.song-detail { min-width: 0; }
.song-title { font-size: var(--fs-md); color: var(--color-text-primary); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-meta { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted); }
.song-actions { display: flex; gap: 0.3rem; flex-shrink: 0; }

.tag-editor { padding: 0.8rem 1rem; background: var(--color-bg-primary); border-top: 1px solid var(--color-border-subtle); }
.tag-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.7rem; margin-bottom: 0.7rem; }
.tag-actions { display: flex; gap: 0.5rem; }
</style>
