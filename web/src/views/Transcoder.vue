<script setup lang="ts">
import { ref } from "vue";

const inputFile = ref<File | null>(null);
const outputFormat = ref("mp3");
const bitrate = ref(192);
const status = ref("");
const log = ref<string[]>([]);

function addLog(msg: string) { log.value.push(msg); if (log.value.length > 50) log.value.shift(); }

async function transcode() {
  if (!inputFile.value) { status.value = "Select a file first"; return; }
  status.value = "Loading FFmpeg WASM...";
  addLog(`Loading FFmpeg WASM for ${inputFile.value.name}`);

  try {
    const { createFFmpeg, fetchFile } = await import("@ffmpeg/ffmpeg");
    const ffmpeg = createFFmpeg({ log: true });
    ffmpeg.setLogger(({ type, message }) => addLog(`[${type}] ${message}`));

    await ffmpeg.load();
    addLog("FFmpeg WASM loaded ✓");

    ffmpeg.FS("writeFile", "input", await fetchFile(inputFile.value));
    addLog(`Input loaded: ${(inputFile.value.size / 1024 / 1024).toFixed(1)} MB`);

    const args = ["-i", "input"];
    if (outputFormat.value === "mp3") args.push("-b:a", `${bitrate.value}k`, "-codec:a", "libmp3lame", "output.mp3");
    else if (outputFormat.value === "flac") args.push("output.flac");
    else if (outputFormat.value === "aac") args.push("-b:a", `${bitrate.value}k`, "output.aac");
    else if (outputFormat.value === "opus") args.push("-b:a", `${bitrate.value}k`, "output.opus");
    else if (outputFormat.value === "wav") args.push("output.wav");
    else if (outputFormat.value === "ogg") args.push("-b:a", `${bitrate.value}k`, "output.ogg");

    addLog(`Running: ffmpeg ${args.join(" ")}`);
    await ffmpeg.run(...args);

    const outName = `output.${outputFormat.value}`;
    const data = ffmpeg.FS("readFile", outName);
    addLog(`Complete: ${(data.length / 1024).toFixed(1)} KB`);

    const blob = new Blob([data.buffer], { type: `audio/${outputFormat.value === "mp3" ? "mpeg" : outputFormat.value}` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${inputFile.value.name.replace(/\.[^.]+$/, "")}.${outputFormat.value}`;
    a.click();
    URL.revokeObjectURL(url);
    status.value = "Done! Download started.";
  } catch (err: unknown) {
    status.value = "Transcoding failed";
    addLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files?.length) {
    inputFile.value = target.files[0];
    addLog(`Selected: ${inputFile.value.name}`);
  }
}

const formats = [
  { value: "mp3", label: "MP3", desc: "Best compatibility" },
  { value: "flac", label: "FLAC", desc: "Lossless" },
  { value: "aac", label: "AAC", desc: "High quality" },
  { value: "opus", label: "Opus", desc: "Best compression" },
  { value: "ogg", label: "OGG Vorbis", desc: "Open format" },
  { value: "wav", label: "WAV", desc: "Uncompressed" },
];
</script>

<template>
  <div class="page">
    <div class="page-header"><h1 class="page-title">Transcoder</h1><span class="badge badge-blue">FFmpeg WASM</span></div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><span class="card-title">Source</span></div>
        <div style="display:flex; flex-direction:column; gap:16px">
          <div class="form-group">
            <label class="form-label">Input File</label>
            <input type="file" accept="audio/*" class="form-input" @change="onFileChange" />
          </div>
          <div v-if="inputFile" class="file-info">
            <span class="file-name">{{ inputFile.name }}</span>
            <span class="file-size">{{ (inputFile.size / 1024 / 1024).toFixed(1) }} MB</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><span class="card-title">Output Settings</span></div>
        <div style="display:flex; flex-direction:column; gap:16px">
          <div class="form-group">
            <label class="form-label">Format</label>
            <select v-model="outputFormat" class="form-select">
              <option v-for="f in formats" :key="f.value" :value="f.value">{{ f.label }} — {{ f.desc }}</option>
            </select>
          </div>
          <div v-if="['mp3', 'aac', 'opus', 'ogg'].includes(outputFormat)" class="form-group">
            <label class="form-label">Bitrate: {{ bitrate }} kbps</label>
            <input type="range" v-model="bitrate" min="32" max="512" step="16" style="width:100%" />
            <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted)"><span>32</span><span>512</span></div>
          </div>
          <button class="btn btn-primary" @click="transcode" :disabled="!inputFile">Start Transcoding</button>
          <span v-if="status" :class="['status', { error: status.includes('fail') }]">{{ status }}</span>
        </div>
      </div>
    </div>

    <div class="card log-panel">
      <div class="card-header"><span class="card-title">Log</span></div>
      <div class="log-box">
        <div v-for="(l, i) in log" :key="i" class="log-line">{{ l }}</div>
        <div v-if="!log.length" class="log-empty">Transcoding log will appear here...</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { max-width: 1000px; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.page-title { font-size: 20px; font-weight: 700; }
.file-info { display: flex; gap: 12px; padding: 8px; background: var(--bg-primary); border-radius: 6px; font-size: 13px; }
.file-name { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { color: var(--text-muted); }
.status { font-size: 13px; color: var(--success); }
.status.error { color: var(--danger); }
.log-panel { margin-top: 16px; }
.log-box { max-height: 240px; overflow-y: auto; background: var(--bg-primary); border-radius: 4px; padding: 10px; font-family: monospace; font-size: 12px; }
.log-line { color: var(--text-secondary); padding: 2px 0; border-bottom: 1px solid rgba(48, 54, 61, 0.3); white-space: pre-wrap; word-break: break-all; }
.log-empty { color: var(--text-muted); text-align: center; padding: 16px; }
</style>
