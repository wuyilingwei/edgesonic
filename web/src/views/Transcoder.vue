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
import { ref } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const inputFile = ref<File | null>(null);
const outputFormat = ref("mp3");
const bitrate = ref(192);
const status = ref("");
const statusErr = ref(false);
const log = ref<string[]>([]);

function addLog(msg: string) { log.value.push(msg); if (log.value.length > 50) log.value.shift(); }

async function transcode() {
  if (!inputFile.value) { status.value = t("transcoder.selectFirst"); statusErr.value = true; return; }
  status.value = t("transcoder.loadingWasm");
  statusErr.value = false;
  addLog(`Loading FFmpeg WASM for ${inputFile.value.name}`);

  try {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ type, message }) => addLog(`[${type}] ${message}`));

    await ffmpeg.load();
    addLog("FFmpeg WASM loaded ✓");

    await ffmpeg.writeFile("input", new Uint8Array(await inputFile.value.arrayBuffer()));
    addLog(`Input loaded: ${(inputFile.value.size / 1024 / 1024).toFixed(1)} MB`);

    const args = ["-i", "input"];
    if (outputFormat.value === "mp3") args.push("-b:a", `${bitrate.value}k`, "-codec:a", "libmp3lame", "output.mp3");
    else if (outputFormat.value === "flac") args.push("output.flac");
    else if (outputFormat.value === "aac") args.push("-b:a", `${bitrate.value}k`, "output.aac");
    else if (outputFormat.value === "opus") args.push("-b:a", `${bitrate.value}k`, "output.opus");
    else if (outputFormat.value === "wav") args.push("output.wav");
    else if (outputFormat.value === "ogg") args.push("-b:a", `${bitrate.value}k`, "output.ogg");

    addLog(`Running: ffmpeg ${args.join(" ")}`);
    await ffmpeg.exec(args);

    const outName = `output.${outputFormat.value}`;
    const data = (await ffmpeg.readFile(outName)) as Uint8Array;
    addLog(`Complete: ${(data.length / 1024).toFixed(1)} KB`);

    const blob = new Blob([data as BlobPart], { type: `audio/${outputFormat.value === "mp3" ? "mpeg" : outputFormat.value}` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${inputFile.value.name.replace(/\.[^.]+$/, "")}.${outputFormat.value}`;
    a.click();
    URL.revokeObjectURL(url);
    status.value = t("transcoder.done");
  } catch (err: unknown) {
    status.value = t("transcoder.failed");
    statusErr.value = true;
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
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("transcoder.label") }}</div>
        <h1 class="page-title">{{ t("transcoder.title") }}</h1>
      </div>
      <span class="status-badge info">FFMPEG WASM</span>
    </div>

    <!-- 079: lightweight intro so users land on this page knowing what it
         does without having to scroll the source/output cards. -->
    <div class="transcoder-intro">
      <p>{{ t("transcoder.description") }}</p>
      <p class="muted">{{ t("transcoder.hint") }}</p>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><span class="card-title">{{ t("transcoder.source") }}</span></div>
        <div style="display:flex; flex-direction:column; gap:1rem">
          <div class="form-group">
            <label class="form-label">{{ t("transcoder.inputFile") }}</label>
            <input type="file" accept="audio/*" class="form-input" @change="onFileChange" />
          </div>
          <div v-if="inputFile" class="file-info">
            <span class="file-name">{{ inputFile.name }}</span>
            <span class="file-size">{{ (inputFile.size / 1024 / 1024).toFixed(1) }} MB</span>
          </div>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>

      <div class="card">
        <div class="card-header"><span class="card-title">{{ t("transcoder.outputSettings") }}</span></div>
        <div style="display:flex; flex-direction:column; gap:1rem">
          <div class="form-group">
            <label class="form-label">{{ t("transcoder.format") }}</label>
            <select v-model="outputFormat" class="form-select">
              <option v-for="f in formats" :key="f.value" :value="f.value">{{ f.label }} — {{ f.desc }}</option>
            </select>
          </div>
          <div v-if="['mp3', 'aac', 'opus', 'ogg'].includes(outputFormat)" class="form-group">
            <label class="form-label">{{ t("transcoder.bitrate", { n: bitrate }) }}</label>
            <input type="range" v-model="bitrate" min="32" max="512" step="16" class="bitrate-range" />
            <div class="range-marks"><span>32</span><span>512</span></div>
          </div>
          <button class="btn-primary" @click="transcode" :disabled="!inputFile">{{ t("transcoder.start") }}</button>
          <span v-if="status" :class="['status', { error: statusErr }]">{{ status }}</span>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <div class="card log-panel">
      <div class="card-header"><span class="card-title">{{ t("transcoder.log") }}</span></div>
      <div class="log-box">
        <div v-for="(l, i) in log" :key="i" class="log-line">{{ l }}</div>
        <div v-if="!log.length" class="log-empty">{{ t("transcoder.logEmpty") }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { max-width: 1000px; }

/* 079: intro card sits between page-header and the grid. Deliberately
   lightweight — no corner glyphs, no shadow — so it doesn't compete with
   the existing .card chrome below. */
.transcoder-intro {
  margin: 0 0 1.25rem;
  padding: 0.85rem 1rem;
  border-left: 2px solid var(--color-accent-primary);
  background: var(--color-bg-secondary);
}
.transcoder-intro p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--fs-md);
  line-height: 1.5;
}
.transcoder-intro p.muted {
  margin-top: 0.35rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}

.file-info {
  display: flex; gap: 0.8rem;
  padding: 0.5rem 0.7rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.file-name { color: var(--color-text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { color: var(--color-text-muted); }
.bitrate-range { width: 100%; accent-color: var(--color-accent-primary); }
.range-marks {
  display: flex; justify-content: space-between;
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--color-text-muted);
}
.status { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--color-status-success); }
.status.error { color: var(--color-status-error); }
.log-panel { margin-top: 1rem; }
.log-box {
  max-height: 240px; overflow-y: auto;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  padding: 0.7rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
}
.log-line { color: var(--color-text-secondary); padding: 2px 0; border-bottom: 1px solid var(--color-border-subtle); white-space: pre-wrap; word-break: break-all; }
.log-empty { font-family: var(--font-mono); color: var(--color-text-muted); text-align: center; padding: 1rem; letter-spacing: 0.1em; }
</style>
