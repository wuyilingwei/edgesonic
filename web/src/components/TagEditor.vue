<script setup lang="ts">
// TagEditor — reusable modal for single & batch tag edits (task 039).
//
// Slots
//   #cover  : rendered above the form (task 042 will inject a drop-zone here).
//   #extras : rendered between the form and the actions row
//             (task 040 will inject a "scrape metadata" button here).
//
// Caller wires up:
//   - `mode`        : 'single' | 'batch'
//   - `songIds`     : 1 id for single, N (<=50) for batch
//   - `initialTags` : prefill values (only consulted in single mode)
//
// Emits:
//   - submit(patch) : object with only the fields the user wants written.
//                     In batch mode, fields whose `apply` checkbox is OFF are
//                     stripped, so the worker leaves them untouched.
//   - close         : user clicked Cancel / backdrop.
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
  (e: "submit", patch: Record<string, string | number>): void;
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
}

watch(() => props.open, (v) => { if (v) resetFromProps(); }, { immediate: true });

const isBatch = computed(() => props.mode === "batch");

function buildPatch(): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  const wantField = (k: keyof typeof apply, value: string): boolean => {
    if (!value.trim()) return false;
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
  if (wantField("year", form.year)) {
    const n = parseInt(form.year, 10);
    if (Number.isInteger(n) && n > 0) patch.year = n;
  }
  if (wantField("track", form.track)) {
    const n = parseInt(form.track, 10);
    if (Number.isInteger(n) && n > 0) patch.track = n;
  }
  // disc / comment / lyrics intentionally stripped — backend doesn't accept
  // them yet (042 / 036 will widen SongTags). UI keeps the inputs so the
  // form layout is final.

  return patch;
}

const patchPreview = computed(() => Object.keys(buildPatch()));

function onSubmit() {
  const patch = buildPatch();
  if (Object.keys(patch).length === 0) return;
  emit("submit", patch);
}

function onClose() {
  emit("close");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onClose">
    <div class="modal tag-editor-modal">
      <div class="modal-title">
        {{ props.title || (isBatch ? t("tagEditor.batchTitle", { n: songIds.length }) : t("tagEditor.singleTitle")) }}
      </div>

      <!-- cover slot — 042 will inject a drag-drop zone here -->
      <slot name="cover">
        <div class="cover-slot-placeholder mono-label">{{ t("tagEditor.coverPlaceholder") }}</div>
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

        <!-- Comment / Lyrics (UI-only for now) -->
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
            <label class="form-label">{{ t("tagEditor.fieldLyrics") }} <span class="future-tag">{{ t("tagEditor.uiOnly") }}</span></label>
            <textarea v-model="form.lyrics" class="form-textarea lyrics-input" rows="3" :disabled="isBatch && !apply.lyrics"></textarea>
          </div>
        </div>
      </div>

      <p class="field-hint">{{ isBatch ? t("tagEditor.hintBatch") : t("tagEditor.hintSingle") }}</p>

      <!-- extras slot — 040 will inject scrape buttons here -->
      <slot name="extras" :patch-preview="patchPreview" :form="form" :apply="apply"></slot>

      <p v-if="message" :class="['te-msg', { error: error }]">{{ message }}</p>

      <div class="modal-actions">
        <button class="btn-secondary" @click="onClose">{{ t("common.cancel") }}</button>
        <button class="btn-primary" :disabled="busy || patchPreview.length === 0" @click="onSubmit">
          {{ busy ? t("common.loading") : (isBatch ? t("tagEditor.applyBatch", { n: patchPreview.length }) : t("common.save")) }}
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
</style>
