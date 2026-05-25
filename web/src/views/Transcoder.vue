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

const inputFile = ref<File | null>(null);
const outputFormat = ref("mp3");
const bitrate = ref(192);
const status = ref("");
const log = ref<string[]>([]);

function addLog(msg: string) { log.value.push(msg); }

async function transcode() {
  if (!inputFile.value) { status.value = "Select a file first"; return; }
  status.value = "Starting FFmpeg WASM...";
  addLog(`Loading FFmpeg WASM for ${inputFile.value.name}`);

  const { createFFmpeg, fetchFile } = await import("@ffmpeg/ffmpeg");
  const ffmpeg = createFFmpeg({ log: true });
  ffmpeg.setLogger(({ type, message }) => addLog(`[${type}] ${message}`));

  await ffmpeg.load();
  addLog("FFmpeg WASM loaded");

  ffmpeg.FS("writeFile", "input", await fetchFile(inputFile.value));
  addLog("Input file loaded");

  const args = ["-i", "input"];
  if (outputFormat.value === "mp3") args.push("-b:a", `${bitrate.value}k`, "output.mp3");
  else if (outputFormat.value === "flac") args.push("output.flac");
  else if (outputFormat.value === "aac") args.push("-b:a", `${bitrate.value}k`, "output.aac");
  else if (outputFormat.value === "opus") args.push("-b:a", `${bitrate.value}k`, "output.opus");

  try {
    await ffmpeg.run(...args);
    const data = ffmpeg.FS("readFile", `output.${outputFormat.value}`);
    addLog(`Transcode complete: ${data.length} bytes`);

    const blob = new Blob([data.buffer], { type: `audio/${outputFormat.value}` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${inputFile.value.name.replace(/\.[^.]+$/, "")}.${outputFormat.value}`;
    a.click();
    status.value = "Done! Download started.";
  } catch (err: unknown) {
    status.value = "Transcode failed";
    addLog(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  if (target.files?.length) inputFile.value = target.files[0];
}
</script>

<template>
  <div>
    <h1 style="margin-bottom:16px">Transcoder (FFmpeg WASM)</h1>

    <div class="panel">
      <div class="row">
        <label>Source File</label>
        <input type="file" accept="audio/*" @change="onFileChange" />
        <span v-if="inputFile" class="filename">{{ inputFile.name }}</span>
      </div>
      <div class="row">
        <label>Output Format</label>
        <select v-model="outputFormat">
          <option value="mp3">MP3</option>
          <option value="flac">FLAC</option>
          <option value="aac">AAC</option>
          <option value="opus">Opus</option>
        </select>
        <label v-if="['mp3', 'aac', 'opus'].includes(outputFormat)">Bitrate (kbps)</label>
        <input v-if="['mp3', 'aac', 'opus'].includes(outputFormat)" type="number" v-model="bitrate" min="16" max="512" style="width:80px" />
      </div>
      <button @click="transcode" class="btn primary" :disabled="!inputFile">Transcode</button>
      <span v-if="status" class="status">{{ status }}</span>
    </div>

    <div v-if="log.length" class="log">
      <div v-for="(line, i) in log" :key="i" class="log-line">{{ line }}</div>
    </div>
  </div>
</template>

<style scoped>
.panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; max-width: 600px; display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; align-items: center; gap: 10px; }
.row label { font-size: 13px; color: #8b949e; min-width: 100px; }
.row select, .row input[type="number"] { padding: 6px 8px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 13px; }
.filename { font-size: 12px; color: #58a6ff; }
.btn { padding: 10px 20px; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: #238636; border-color: #238636; }
.status { font-size: 13px; color: #8b949e; }
.log { margin-top: 20px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; }
.log-line { padding: 2px 0; color: #8b949e; }
</style>
