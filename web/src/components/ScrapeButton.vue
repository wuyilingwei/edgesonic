<script setup lang="ts">
// ScrapeButton — fetches metadata from external providers and emits a chosen
// result back to the parent. Lives inside TagEditor's `#extras` slot (task 040).
//
// Flow:
//   1. user clicks "Scrape metadata" → searchAll() against enabled sources
//   2. result panel opens; user picks a row
//   3. emit('apply', result) → parent (TagEditor host) merges fields into form
//   4. parent also calls submitResult() to leave an audit row (status='applied')
//
// The component is dumb about WHERE the form fields live: it only emits the
// chosen ScrapeResult. ts/Library.vue + Files.vue own the merge logic.

import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import {
  searchAll,
  submitResult,
  makeProxyFetch,
  type ScrapeResult,
  type ScrapeSource,
} from "../lib/scrape";

const { t } = useI18n();
const { edgesonicFetch, tagPost } = useAuth();

const props = withDefaults(
  defineProps<{
    /** Pre-filled query string. The component shows it in an editable input. */
    initialQuery?: string;
    /** Song master id — if present, submitResult will tag the audit row. */
    songMasterId?: string;
    /** Compact mode hides the help text (good for narrow modals). */
    compact?: boolean;
  }>(),
  { initialQuery: "", songMasterId: "", compact: false }
);

const emit = defineEmits<{
  (e: "apply", result: ScrapeResult): void;
}>();

// === Source config (pulled from /rest/getFeatures) ===========================
const enabledSources = ref<ScrapeSource[]>([]);
const scrapeEnabled = ref<boolean>(true);
const configReady = ref(false);

async function loadConfig() {
  try {
    const data = JSON.parse(await edgesonicFetch("features/list"));
    if (!data.ok) throw new Error(data.error || "getFeatures failed");
    const flag = (data.features || []).find((f: { key: string }) => f.key === "scrape_enabled");
    scrapeEnabled.value = flag ? Number(flag.value) !== 0 : true;
    const list = (data.featureStrings || []).find((f: { key: string }) => f.key === "scrape_enabled_sources");
    if (list?.value) {
      try {
        const parsed = JSON.parse(list.value);
        if (Array.isArray(parsed)) enabledSources.value = parsed as ScrapeSource[];
      } catch { enabledSources.value = ["netease", "qmusic", "kugou"]; }
    } else {
      enabledSources.value = ["netease", "qmusic", "kugou"];
    }
  } catch {
    // Settings unreachable (perm denied for non-admin?) — fall back to defaults
    // so end users can still scrape; the proxy itself is session-only either way.
    enabledSources.value = ["netease", "qmusic", "kugou"];
    scrapeEnabled.value = true;
  }
  configReady.value = true;
}

// === Search state ===========================================================
const query = ref(props.initialQuery);
const open = ref(false);
const busy = ref(false);
const results = ref<ScrapeResult[]>([]);
const errors = ref<Array<{ source: ScrapeSource; error: string }>>([]);
const error = ref("");

watch(() => props.initialQuery, (v) => { query.value = v; });

const hasResults = computed(() => results.value.length > 0);
const sourceLabel: Record<ScrapeSource, string> = {
  netease: "NetEase",
  qmusic: "QQ Music",
  kugou: "Kugou",
  kuwo: "Kuwo",
  migu: "Migu",
};

async function runSearch() {
  if (!configReady.value) await loadConfig();
  if (!scrapeEnabled.value) {
    error.value = t("scrape.disabled");
    return;
  }
  const q = query.value.trim();
  if (!q) {
    error.value = t("scrape.emptyQuery");
    return;
  }
  busy.value = true;
  error.value = "";
  results.value = [];
  errors.value = [];
  try {
    const proxy = makeProxyFetch(tagPost);
    const resp = await searchAll({
      query: q,
      sources: enabledSources.value,
      proxyFetch: proxy,
    });
    results.value = resp.results;
    errors.value = resp.errors;
    if (!resp.results.length) {
      error.value = resp.errors.length
        ? t("scrape.allSourcesFailed")
        : t("scrape.noResults");
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
  busy.value = false;
}

function openPanel() {
  open.value = true;
  if (configReady.value === false) loadConfig();
  // Auto-run search if the parent supplied a meaningful initial query and we
  // haven't searched yet — saves a click in the common case.
  if (!hasResults.value && query.value.trim().length >= 2) {
    runSearch();
  }
}

function closePanel() {
  open.value = false;
}

async function applyResult(r: ScrapeResult) {
  emit("apply", r);
  // Fire-and-forget audit row. Failure here doesn't block the apply (the user
  // already got their tags merged; the row is best-effort tracking).
  try {
    await submitResult(
      {
        songMasterId: props.songMasterId || undefined,
        source: r.source,
        songId: r.songId,
        query: query.value.trim(),
        result: r,
        mode: "tags",
      },
      tagPost,
    );
  } catch {/* swallow — caller already saw the merge */}
  closePanel();
}
</script>

<template>
  <div class="scrape-button-wrap">
    <button class="btn-secondary scrape-trigger" :disabled="busy" @click="openPanel">
      <span class="scrape-icon">⌕</span>
      {{ t("scrape.button") }}
    </button>

    <div v-if="open" class="scrape-panel">
      <div class="scrape-search-row">
        <input
          v-model="query"
          class="form-input scrape-query"
          :placeholder="t('scrape.queryPlaceholder')"
          @keydown.enter.prevent="runSearch"
          @keydown.escape.prevent="closePanel"
        />
        <button class="btn-primary btn-sm" :disabled="busy" @click="runSearch">
          {{ busy ? t("common.loading") : t("scrape.searchBtn") }}
        </button>
        <button class="btn-secondary btn-sm" @click="closePanel">{{ t("common.close") }}</button>
      </div>

      <p v-if="!compact" class="scrape-hint mono-label">
        {{ t("scrape.hint", { sources: enabledSources.map((s) => sourceLabel[s]).join(" → ") }) }}
      </p>

      <p v-if="error" class="scrape-error">{{ error }}</p>

      <div v-if="errors.length" class="scrape-source-errors">
        <span v-for="e in errors" :key="e.source" class="scrape-source-error">
          {{ sourceLabel[e.source] }}: {{ e.error }}
        </span>
      </div>

      <div v-if="results.length" class="scrape-results">
        <div v-for="(r, i) in results" :key="`${r.source}-${r.songId}-${i}`" class="scrape-row">
          <div class="scrape-row-main">
            <span class="scrape-source-pill" :data-src="r.source">{{ sourceLabel[r.source] }}</span>
            <span class="scrape-row-title">{{ r.title || "—" }}</span>
            <span class="scrape-row-artist">{{ r.artist || "—" }}</span>
            <span class="scrape-row-album">{{ r.album || "" }}</span>
            <span v-if="r.year" class="scrape-row-year">{{ r.year }}</span>
          </div>
          <button class="btn-primary btn-sm" @click="applyResult(r)">{{ t("scrape.apply") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrape-button-wrap { margin: 0.7rem 0 0; }
.scrape-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.scrape-icon { font-family: var(--font-mono); color: var(--color-accent-primary); }

.scrape-panel {
  margin-top: 0.7rem;
  padding: 0.75rem;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.scrape-search-row { display: flex; gap: 0.5rem; align-items: center; }
.scrape-query { flex: 1; min-width: 180px; }

.scrape-hint {
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  margin: 0;
}
.scrape-error {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--color-status-error);
  margin: 0;
}
.scrape-source-errors {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.scrape-source-error {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  padding: 0.15rem 0.45rem;
  border: 1px dashed var(--color-border-subtle);
}

.scrape-results {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 260px;
  overflow-y: auto;
  border-top: 1px dashed var(--color-border-subtle);
  padding-top: 0.5rem;
}
.scrape-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border-subtle);
}
.scrape-row-main {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
  min-width: 0;
}
.scrape-source-pill {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-primary);
  color: var(--color-accent-primary);
}
.scrape-row-title { font-weight: 600; color: var(--color-text-primary); }
.scrape-row-artist { color: var(--color-text-secondary); font-size: var(--fs-sm); }
.scrape-row-album { color: var(--color-text-muted); font-size: var(--fs-sm); }
.scrape-row-year {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}
</style>
