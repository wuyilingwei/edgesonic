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
// TagEditor — reusable modal for single & batch tag edits (task 039).
//
// Slots
//  #cover : rendered above the form (task 042 will inject a drop-zone here).
//  #extras : rendered between the form and the actions row
//           (task 040 will inject a "scrape metadata" button here).
//
// Caller wires up:
//   - `mode`      : 'single' | 'batch'
//   - `songIds`   : 1 id for single, N (<=50) for batch
//  - `initialTags` : prefill values (only consulted in single mode)
//
// Emits:
//  - submit(patch) : object with only the fields the user wants written.
//                   In batch mode, fields whose `apply` checkbox is OFF are
//                   stripped, so the worker leaves them untouched.
//   - close       : user clicked Cancel / backdrop.
//
// Future tasks (040 scrape, 042 cover writeback) can extend the patch shape
// via the same `submit` event — `disc/comment/lyrics` already have inputs but
// are stripped from the patch until the backend tagwrite kernel grows the
// matching frames. See agents/039_*/findings.md for the rationale.

import { ref, reactive, computed, watch } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

interface InitialTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: string | number;
  track?: string | number;
  disc?: string | number;
  comment?: string;
  lyrics?: string;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    mode: "single" | "batch";
    songIds: string[];
    initialTags?: InitialTags;
    title?: string;
    busy?: boolean;
    message?: string;
    error?: boolean;
  }>(),
  { busy: false, message: "", error: false, initialTags: () => ({}) }
);

const emit = defineEmits<{
  // instead of base64 bytes; the worker detects and routes accordingly. Callers
  // that don't care about cover writeback can ignore the second arg.
  (e: "submit", patch: Record<string, string | number>, cover?: { data: string; mime: string }): void;
  (e: "close"): void;
}>();

// === Form state =============================================================
// Two-level state: `form` carries the raw input strings, `apply` (batch only)
// flags which fields should land in the emitted patch.
const form = reactive({
  title: "", artist: "", album: "", albumArtist: "",
  genre: "", year: "", track: "", disc: "",
  comment: "", lyrics: "",
});

const apply = reactive({
  title: false, artist: false, album: false, albumArtist: false,
  genre: false, year: false, track: false, disc: false,
  comment: false, lyrics: false,
});

// === 042 cover state =========================================================
// Picked image → canvas-compressed JPEG ≤500KB → base64 string for upload.
// `coverPreviewUrl` is a smaller (≤200px) blob URL for the thumbnail.
const COVER_MAX_BYTES = 500 * 1024;
const COVER_MAX_DIM = 1500;            // pre-scale longest side before quality iteration
const COVER_PREVIEW_DIM = 200;
const coverData = ref<string>("");      // base64 (no data URL prefix)
const coverMime = ref<"image/jpeg" | "image/png">("image/jpeg");
const coverPreviewUrl = ref<string>("");
const coverInfo = ref<string>("");
const coverError = ref<string>("");
const coverBusy = ref(false);
const coverInputEl = ref<HTMLInputElement | null>(null);

// picked image: choosing a keyword clears any picked cover, and picking an
// image clears the keyword. Empty string means "no cover op".
const coverKeyword = ref<"" | typeof KW_WRITE | typeof KW_EXPORT>("");

function resetFromProps() {
  const i = props.initialTags || {};
  form.title = String(i.title ?? "");
  form.artist = String(i.artist ?? "");
  form.album = String(i.album ?? "");
  form.albumArtist = String(i.albumArtist ?? "");
  form.genre = String(i.genre ?? "");
  form.year = String(i.year ?? "");
  form.track = String(i.track ?? "");
  form.disc = String(i.disc ?? "");
  form.comment = String(i.comment ?? "");
  form.lyrics = String(i.lyrics ?? "");
  // batch mode starts with nothing applied; single mode every present field
  // is "applied" implicitly (we don't show the checkboxes).
  for (const k of Object.keys(apply) as Array<keyof typeof apply>) apply[k] = false;
  // Drop any previously-picked cover when the modal re-opens.
  if (coverPreviewUrl.value) URL.revokeObjectURL(coverPreviewUrl.value);
  coverData.value = "";
  coverPreviewUrl.value = "";
  coverInfo.value = "";
  coverError.value = "";
  coverKeyword.value = "";
}

watch(() => props.open, (v) => { if (v) resetFromProps(); }, { immediate: true });

const isBatch = computed(() => props.mode === "batch");

// verbatim to the worker, which interprets them. The UI just passes them
// through like any other string value (subject to the apply checkbox in
// batch mode).
const KW_NULL = "{null}";
const KW_WRITE = "{write}";
const KW_EXPORT = "{export}";
const KEYWORDS = new Set([KW_NULL, KW_WRITE, KW_EXPORT]);
function isKeyword(v: string): boolean {
  return KEYWORDS.has(v);
}

function buildPatch(): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  const wantField = (k: keyof typeof apply, value: string): boolean => {
    const kw = isKeyword(value.trim());
    if (!kw && !value.trim()) return false;
    if (isBatch.value) return apply[k];
    // single mode: only include changed values (vs. initial). This keeps the
    // worker's COALESCE semantics intact for fields the user left untouched.
    const init = String((props.initialTags as Record<string, unknown>)?.[k] ?? "");
    return value.trim() !== init.trim();
  };

  if (wantField("title", form.title)) patch.title = form.title.trim();
  if (wantField("artist", form.artist)) patch.artist = form.artist.trim();
  if (wantField("album", form.album)) patch.album = form.album.trim();
  if (wantField("albumArtist", form.albumArtist)) patch.albumArtist = form.albumArtist.trim();
  if (wantField("genre", form.genre)) patch.genre = form.genre.trim();
  if (wantField("lyrics", form.lyrics)) patch.lyrics = form.lyrics.trim();
  if (!isKeyword(form.year.trim())) {
    if (wantField("year", form.year)) {
      const n = parseInt(form.year, 10);
      if (Number.isInteger(n) && n > 0) patch.year = n;
    }
  } else if (isBatch.value ? apply.year : true) {
    // keyword path? no — year is numeric, worker cleanInput only keyword-enables
    // lyrics + string fields). We forward the literal only for lyrics; for
    // numeric fields we skip (UI doesn't advertise {null} on year/track).
  }
  if (!isKeyword(form.track.trim())) {
    if (wantField("track", form.track)) {
      const n = parseInt(form.track, 10);
      if (Number.isInteger(n) && n > 0) patch.track = n;
    }
  }
  // disc / comment intentionally stripped — backend doesn't accept them yet.
  // lyrics is forwarded above (keyword-aware).

  return patch;
}

const patchPreview = computed(() => Object.keys(buildPatch()));
const hasCover = computed(() => coverData.value.length > 0 || coverKeyword.value.length > 0);

function onSubmit() {
  const patch = buildPatch();
  // rides on the cover arg's `data` field as a literal string. Block the click
  // only when nothing is pending.
  if (Object.keys(patch).length === 0 && !hasCover.value) return;
  let cover: { data: string; mime: string } | undefined;
  if (coverKeyword.value) {
    cover = { data: coverKeyword.value, mime: "image/jpeg" };
  } else if (coverData.value) {
    cover = { data: coverData.value, mime: coverMime.value };
  }
  emit("submit", patch, cover);
}

function onClose() {
  emit("close");
}

// === 042 cover picker ========================================================

function onCoverDrop(e: DragEvent) {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleCoverFile(file);
}
function onCoverPick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) handleCoverFile(file);
}
function triggerCoverPick() {
  coverInputEl.value?.click();
}
function clearCover() {
  if (coverPreviewUrl.value) URL.revokeObjectURL(coverPreviewUrl.value);
  coverData.value = "";
  coverPreviewUrl.value = "";
  coverInfo.value = "";
  coverError.value = "";
  coverKeyword.value = "";
  if (coverInputEl.value) coverInputEl.value.value = "";
}
// a keyword button is toggled on).
function clearCoverImageOnly() {
  if (coverPreviewUrl.value) URL.revokeObjectURL(coverPreviewUrl.value);
  coverData.value = "";
  coverPreviewUrl.value = "";
  coverInfo.value = "";
  coverError.value = "";
  if (coverInputEl.value) coverInputEl.value.value = "";
}

async function handleCoverFile(file: File) {
  coverError.value = "";
  if (!/^image\//i.test(file.type)) {
    coverError.value = t("tagEditor.cover.errInvalidType");
    return;
  }
  coverKeyword.value = "";
  coverBusy.value = true;
  try {
    const img = await loadImage(file);
    // Pre-scale so we are never compressing a 6000x6000 source.
    const { width, height } = fitInto(img.width, img.height, COVER_MAX_DIM);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, width, height);

    // Iterate JPEG quality until the encoded blob fits the 500KB ceiling. We
    // start high so good source photos retain quality, then back off step by
    // step. Floor at 0.4 — below that the artefacts make the photo unusable.
    const qualities = [0.85, 0.7, 0.55, 0.4];
    let blob: Blob | null = null;
    for (const q of qualities) {
      blob = await canvasToBlob(canvas, "image/jpeg", q);
      if (blob && blob.size <= COVER_MAX_BYTES) break;
    }
    if (!blob) throw new Error("encode failed");
    if (blob.size > COVER_MAX_BYTES) {
      coverError.value = t("tagEditor.cover.errTooLarge", { kb: Math.round(blob.size / 1024) });
      coverBusy.value = false;
      return;
    }
    coverData.value = await blobToBase64(blob);
    coverMime.value = "image/jpeg";

    // Generate a small thumbnail for the in-modal preview (separate canvas →
    // a separate blob URL so re-encoding the main blob doesn't blur it).
    const thumb = document.createElement("canvas");
    const t2 = fitInto(width, height, COVER_PREVIEW_DIM);
    thumb.width = t2.width; thumb.height = t2.height;
    const tctx = thumb.getContext("2d");
    if (tctx) {
      tctx.drawImage(img, 0, 0, t2.width, t2.height);
      const thumbBlob = await canvasToBlob(thumb, "image/jpeg", 0.85);
      if (coverPreviewUrl.value) URL.revokeObjectURL(coverPreviewUrl.value);
      coverPreviewUrl.value = thumbBlob ? URL.createObjectURL(thumbBlob) : "";
    }

    coverInfo.value = t("tagEditor.cover.info", {
      kb: Math.round(blob.size / 1024),
      w: width,
      h: height,
    });
  } catch (e) {
    coverError.value = e instanceof Error ? e.message : String(e);
  } finally {
    coverBusy.value = false;
  }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image decode failed")); };
    img.src = url;
  });
}

function fitInto(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = Math.min(max / w, max / h);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Strip the `data:image/jpeg;base64,` prefix — the worker accepts either
      // form but we keep the wire small.
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.substring(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("base64 encode failed"));
    reader.readAsDataURL(blob);
  });
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onClose">
    <div class="modal tag-editor-modal">
      <div class="modal-title">
        {{ props.title || (isBatch ? t("tagEditor.batchTitle", { n: songIds.length }) : t("tagEditor.singleTitle")) }}
      </div>

      <!-- cover slot — 042: drag/drop or click to pick. Canvas-compressed to
           ≤500KB JPEG client-side, base64 attached to the submit payload. -->
      <slot name="cover">
        <div
          class="cover-drop"
          :class="{ 'cover-drop-has': hasCover, 'cover-drop-busy': coverBusy }"
          @dragover.prevent
          @drop.prevent="onCoverDrop"
          @click="triggerCoverPick"
        >
         <input
            ref="coverInputEl"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            class="cover-file-hidden"
            @change="onCoverPick"
          />
          <img v-if="coverPreviewUrl" :src="coverPreviewUrl" class="cover-thumb" alt="cover preview" />
          <div v-if="!hasCover && !coverBusy" class="cover-drop-hint mono-label">
            {{ t("tagEditor.cover.dropHint") }}
          </div>
          <div v-else-if="coverBusy" class="cover-drop-hint mono-label">{{ t("tagEditor.cover.compressing") }}</div>
          <div v-else class="cover-info-row">
            <span class="cover-info mono-label">{{ coverInfo }}</span>
            <button
              type="button"
              class="btn-secondary cover-clear"
              @click.stop="clearCover"
            >{{ t("tagEditor.cover.clear") }}</button>
          </div>
        </div>
        <p v-if="coverError" class="cover-error mono-label">{{ coverError }}</p>
        <!-- cover keyword picker: {write} embeds the album's R2 cover into
             the file; {export} writes cover.jpg sidecar. Mutually exclusive with
             a picked image (choosing one clears the other). -->
        <div class="cover-keyword-row">
          <button
            type="button"
            class="cover-kw-btn"
            :class="{ active: coverKeyword === KW_WRITE }"
            :title="t('tagEditor.cover.writeHint')"
            @click.stop="coverKeyword = (coverKeyword === KW_WRITE ? '' : KW_WRITE); clearCoverImageOnly()"
          >{{ KW_WRITE }}</button>
          <button
            type="button"
            class="cover-kw-btn"
            :class="{ active: coverKeyword === KW_EXPORT }"
            :title="t('tagEditor.cover.exportHint')"
            @click.stop="coverKeyword = (coverKeyword === KW_EXPORT ? '' : KW_EXPORT); clearCoverImageOnly()"
          >{{ KW_EXPORT }}</button>
        </div>
      </slot>

      <div v-if="isBatch" class="batch-hint mono-label">{{ t("tagEditor.batchHint") }}</div>

      <div class="te-form">
        <!-- Title -->
        <div class="te-row">
          <input v-if="isBatch" type="checkbox" v-model="apply.title" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldTitle") }}</label>
            <input v-model="form.title" class="form-input" :disabled="isBatch && !apply.title" />
          </div>
        </div>

        <!-- Artist / Album Artist -->
        <div class="te-row">
          <input v-if="isBatch" type="checkbox" v-model="apply.artist" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldArtist") }}</label>
            <input v-model="form.artist" class="form-input" :disabled="isBatch && !apply.artist" />
          </div>
          <input v-if="isBatch" type="checkbox" v-model="apply.albumArtist" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldAlbumArtist") }}</label>
            <input v-model="form.albumArtist" class="form-input" :placeholder="form.artist" :disabled="isBatch && !apply.albumArtist" />
          </div>
        </div>

        <!-- Album -->
        <div class="te-row">
          <input v-if="isBatch" type="checkbox" v-model="apply.album" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldAlbum") }}</label>
            <input v-model="form.album" class="form-input" :disabled="isBatch && !apply.album" />
          </div>
        </div>

        <!-- Genre / Year / Track / Disc -->
        <div class="te-row">
          <input v-if="isBatch" type="checkbox" v-model="apply.genre" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:2">
            <label class="form-label">{{ t("tagEditor.fieldGenre") }}</label>
            <input v-model="form.genre" class="form-input" :disabled="isBatch && !apply.genre" />
          </div>
          <input v-if="isBatch" type="checkbox" v-model="apply.year" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldYear") }}</label>
            <input v-model="form.year" class="form-input" inputmode="numeric" :disabled="isBatch && !apply.year" />
          </div>
        </div>
        <div class="te-row">
          <input v-if="isBatch" type="checkbox" v-model="apply.track" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldTrack") }}</label>
            <input v-model="form.track" class="form-input" inputmode="numeric" :disabled="isBatch && !apply.track" />
          </div>
          <input v-if="isBatch" type="checkbox" v-model="apply.disc" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldDisc") }} <span class="future-tag">{{ t("tagEditor.uiOnly") }}</span></label>
            <input v-model="form.disc" class="form-input" inputmode="numeric" :disabled="isBatch && !apply.disc" />
          </div>
        </div>

        <!-- Comment / Lyrics (lyrics supports {null}/{write}/{export} keywords — 095) -->
        <div class="te-row">
          <input v-if="isBatch" type="checkbox" v-model="apply.comment" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldComment") }} <span class="future-tag">{{ t("tagEditor.uiOnly") }}</span></label>
            <input v-model="form.comment" class="form-input" :disabled="isBatch && !apply.comment" />
          </div>
        </div>
        <div class="te-row">
          <input v-if="isBatch" type="checkbox" v-model="apply.lyrics" class="apply-check" :title="t('tagEditor.applyField')" />
          <div class="form-group" style="flex:1">
            <label class="form-label">{{ t("tagEditor.fieldLyrics") }}</label>
            <textarea v-model="form.lyrics" class="form-textarea lyrics-input" rows="3" :disabled="isBatch && !apply.lyrics"></textarea>
            <p class="keyword-hint mono-label" v-html="t('tagEditor.lyricsKeywords')"></p>
          </div>
        </div>
      </div>

      <p class="field-hint">{{ isBatch ? t("tagEditor.hintBatch") : t("tagEditor.hintSingle") }}</p>

      <!-- extras slot — 040 will inject scrape buttons here -->
      <slot name="extras" :patch-preview="patchPreview" :form="form" :apply="apply"></slot>

      <p v-if="message" :class="['te-msg', { error: error }]">{{ message }}</p>

      <div class="modal-actions">
        <button class="btn-secondary" @click="onClose">{{ t("common.cancel") }}</button>
        <button class="btn-primary" :disabled="busy || (patchPreview.length === 0 && !hasCover)" @click="onSubmit">
          {{ busy ? t("common.loading") : (isBatch ? t("tagEditor.applyBatch", { n: patchPreview.length + (hasCover ? 1 : 0) }) : t("common.save")) }}
        </button>
      </div>

      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>
  </div>
</template>

<style scoped>
.tag-editor-modal { width: min(620px, 94vw); max-height: 90vh; overflow-y: auto; }
.cover-slot-placeholder {
  margin-bottom: 1rem;
  padding: 0.75rem 1rem;
  border: 1px dashed var(--color-border-subtle);
  text-align: center;
  color: var(--color-text-muted);
  border-radius: 2px;
}
.cover-drop {
  margin-bottom: 0.85rem;
  padding: 0.75rem;
  border: 1px dashed var(--color-border-subtle);
  border-radius: 2px;
  text-align: center;
  cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
  transition: border-color 0.1s, background 0.1s;
}
.cover-drop:hover { border-color: var(--color-accent-primary); background: var(--color-bg-tertiary); }
.cover-drop-has { border-style: solid; border-color: var(--color-border-default); }
.cover-drop-busy { opacity: 0.7; cursor: progress; }
.cover-file-hidden { display: none; }
.cover-drop-hint {
  color: var(--color-text-muted);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
}
.cover-thumb {
  max-width: 200px;
  max-height: 200px;
  object-fit: contain;
  border: 1px solid var(--color-border-subtle);
}
.cover-info-row {
  display: flex; align-items: center; gap: 0.75rem;
  font-family: var(--font-mono); font-size: var(--fs-xs);
  color: var(--color-text-secondary);
}
.cover-info { color: var(--color-accent-primary); }
.cover-clear { font-size: var(--fs-xs); padding: 0.15rem 0.5rem; }
.cover-error {
  margin: 0 0 0.6rem;
  color: var(--color-status-error);
  font-size: var(--fs-xs);
}
.batch-hint {
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-left: 2px solid var(--color-accent-primary);
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
}
.te-form { display: flex; flex-direction: column; gap: 0.6rem; }
.te-row { display: flex; gap: 0.6rem; align-items: flex-end; }
.apply-check {
  width: 16px; height: 16px; flex-shrink: 0;
  accent-color: var(--color-accent-primary);
  margin-bottom: 0.7rem;
  cursor: pointer;
}
.future-tag {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border-subtle);
  padding: 0 0.25rem;
  margin-left: 0.3rem;
  text-transform: lowercase;
}
.lyrics-input { font-family: var(--font-mono); resize: vertical; min-height: 60px; }
.field-hint {
  display: block;
  margin: 0.6rem 0 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}
.te-msg {
  margin-top: 0.6rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-status-success);
}
.te-msg.error { color: var(--color-status-error); }
.form-input:disabled, .form-textarea:disabled { opacity: 0.45; cursor: not-allowed; }
.cover-keyword-row {
  display: flex; gap: 0.4rem;
  margin: 0.4rem 0 0;
}
.cover-kw-btn {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  border-radius: 2px;
  cursor: pointer;
  transition: border-color 0.1s, background 0.1s, color 0.1s;
}
.cover-kw-btn:hover { border-color: var(--color-accent-primary); color: var(--color-text-primary); }
.cover-kw-btn.active {
  border-color: var(--color-accent-primary);
  background: var(--color-accent-primary);
  color: #fff;
}
.keyword-hint {
  display: block;
  margin: 0.35rem 0 0;
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  line-height: 1.5;
}
.keyword-hint :deep(code) {
  font-family: var(--font-mono);
  padding: 0 0.2rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  color: var(--color-text-secondary);
}
</style>
