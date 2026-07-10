<script setup lang="ts">
//   GET      /rest/getShares
//   GET|POST /rest/createShare
//   GET|POST /rest/updateShare
//   GET|POST /rest/deleteShare
// Plus the public byte stream at /share/:id which we never call from JS — the
// URL comes back inside the <share url=".."> attribute and we hand it to the
// clipboard so users can paste it anywhere.
//
// `expires` is sent in MILLISECONDS per Subsonic spec. The server stores
// seconds internally; mapShareDetail.expires is already ISO 8601 by the time
// we receive it so the round-trip is transparent.
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs } from "../api";

const { t } = useI18n();
const { authFetch } = useAuth();

// ===========================================================================
// Types
// ===========================================================================
interface ShareEntry {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverArt?: string;
}
interface Share {
  id: string;
  url: string;
  description: string;
  username: string;
  created: string;
  expires: string;       // empty when never expires
  lastVisited: string;
  visitCount: number;
  entries: ShareEntry[];
}

// ===========================================================================
// Reactive state
// ===========================================================================
const shares = ref<Share[]>([]);
const loading = ref(false);

const showForm = ref(false);
const form = ref({
  targetType: "song" as "song" | "album",
  targetQuery: "",
  targetId: "",
  targetLabel: "",
  description: "",
  expiresType: "never" as "never" | "days" | "datetime",
  expiresDays: 7,
  expiresAt: "",
});
const searchResults = ref<Array<{ id: string; label: string; sub: string }>>([]);
const searching = ref(false);

// Per-share inline "update expires" modal — keep it lightweight (one share at
// a time) rather than fork a global state machine.
const editingExpires = ref<Share | null>(null);
const editExpiresType = ref<"never" | "days" | "datetime">("days");
const editExpiresDays = ref(7);
const editExpiresAt = ref("");

const toast = ref({ show: false, msg: "", type: "success" as "success" | "error" });
function showToast(msg: string, type: "success" | "error" = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

// ===========================================================================
// Helpers — Subsonic XML envelope + share parsing
// ===========================================================================
function failed(xml: string): boolean {
  return /status="failed"/.test(xml);
}
function extractError(xml: string): string | null {
  const m = /<error[^>]+message="([^"]+)"/.exec(xml);
  return m ? m[1] : null;
}

// Decode XML attribute values (&amp;/&lt;/&gt;/&quot;/&#39; → plain).
function decodeAttr(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

// parseXmlAttrs only flattens; share + entry are nested so we split by <share>
// blocks first then run the helper on each block separately.
function parseShares(xml: string): Share[] {
  const out: Share[] = [];
  // Match <share ... > ... </share> AND self-closing <share .../> — getShares
  // returns the long form (with at least one entry), createShare may emit the
  // short form if the underlying songs were since deleted, so handle both.
  const re = /<share\s+([^>]+?)\s*(?:\/>|>([\s\S]*?)<\/share>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = decodeAttr(am[2]);
    const inner = m[2] || "";
    const entries = parseXmlAttrs(inner, "entry").map((e) => ({
      id: e.id || "",
      title: decodeAttr(e.title || ""),
      artist: decodeAttr(e.artist || ""),
      album: decodeAttr(e.album || ""),
      coverArt: e.coverArt || undefined,
    }));
    out.push({
      id: attrs.id || "",
      url: attrs.url || "",
      description: attrs.description || "",
      username: attrs.username || "",
      created: attrs.created || "",
      expires: attrs.expires || "",
      lastVisited: attrs.lastVisited || "",
      visitCount: parseInt(attrs.visitCount || "0", 10) || 0,
      entries,
    });
  }
  return out;
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// ===========================================================================
// Load shares
// ===========================================================================
async function load() {
  loading.value = true;
  try {
    const xml = await authFetch("getShares");
    shares.value = parseShares(xml);
  } catch {
    shares.value = [];
  } finally {
    loading.value = false;
  }
}

// ===========================================================================
// Target search — search3 with the right *Count knobs
// ===========================================================================
async function searchTargets() {
  const q = form.value.targetQuery.trim();
  if (!q) {
    searchResults.value = [];
    return;
  }
  searching.value = true;
  try {
    const params: Record<string, string> = { query: q };
    if (form.value.targetType === "song") {
      params.songCount = "20"; params.albumCount = "0"; params.artistCount = "0";
    } else {
      params.albumCount = "20"; params.songCount = "0"; params.artistCount = "0";
    }
    const xml = await authFetch("search3", params);
    if (form.value.targetType === "song") {
      searchResults.value = parseXmlAttrs(xml, "song").map((s) => ({
        id: s.id || "",
        label: decodeAttr(s.title || ""),
        sub: [decodeAttr(s.artist || ""), decodeAttr(s.album || "")].filter(Boolean).join(" — "),
      }));
    } else {
      searchResults.value = parseXmlAttrs(xml, "album").map((a) => ({
        id: a.id || "",
        label: decodeAttr(a.name || a.title || ""),
        sub: decodeAttr(a.artist || ""),
      }));
    }
  } catch {
    searchResults.value = [];
  } finally {
    searching.value = false;
  }
}

function pickTarget(r: { id: string; label: string; sub: string }) {
  form.value.targetId = r.id;
  form.value.targetLabel = r.sub ? `${r.label} · ${r.sub}` : r.label;
  searchResults.value = [];
  form.value.targetQuery = r.label;
}

function resetForm() {
  form.value = {
    targetType: "song",
    targetQuery: "",
    targetId: "",
    targetLabel: "",
    description: "",
    expiresType: "never",
    expiresDays: 7,
    expiresAt: "",
  };
  searchResults.value = [];
}

// Translate the three expires choices to a millisecond timestamp per
// Subsonic spec. Returns undefined when the user picked "never".
function computeExpiresMs(
  type: "never" | "days" | "datetime",
  days: number,
  datetimeLocal: string,
): number | undefined {
  if (type === "never") return undefined;
  if (type === "days") {
    const d = Number(days);
    if (!Number.isFinite(d) || d <= 0) return undefined;
    return Date.now() + Math.floor(d * 86400000);
  }
  // datetime-local: the value is a local-tz string ("YYYY-MM-DDTHH:mm");
  // Date.parse interprets it as local time — that's what users expect.
  if (!datetimeLocal) return undefined;
  const ts = Date.parse(datetimeLocal);
  if (!Number.isFinite(ts) || ts <= Date.now()) return undefined;
  return ts;
}

// ===========================================================================
// Create
// ===========================================================================
async function createShare() {
  if (!form.value.targetId) {
    showToast(t("shares.targetSelectRequired"), "error");
    return;
  }
  const params: Record<string, string> = { id: form.value.targetId };
  if (form.value.description.trim()) params.description = form.value.description.trim();
  const expiresMs = computeExpiresMs(
    form.value.expiresType,
    form.value.expiresDays,
    form.value.expiresAt,
  );
  if (expiresMs !== undefined) params.expires = String(expiresMs);
  try {
    const xml = await authFetch("createShare", params);
    if (failed(xml)) throw new Error(extractError(xml) || "create failed");
    showToast(t("shares.added"));
    showForm.value = false;
    resetForm();
    // Append the newly-created share at the top so users see it without
    // round-tripping the whole list.
    const created = parseShares(xml);
    if (created.length) shares.value = [created[0], ...shares.value];
    else await load();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("shares.addFailed")}: ${msg}`, "error");
  }
}

// ===========================================================================
// Update expires
// ===========================================================================
function openEditExpires(s: Share) {
  editingExpires.value = s;
  editExpiresType.value = s.expires ? "datetime" : "never";
  editExpiresDays.value = 7;
  // datetime-local needs "YYYY-MM-DDTHH:mm" in local time. Build it from the
  // ISO string the worker handed us.
  if (s.expires) {
    const d = new Date(s.expires);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, "0");
      editExpiresAt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } else {
      editExpiresAt.value = "";
    }
  } else {
    editExpiresAt.value = "";
  }
}
function closeEditExpires() { editingExpires.value = null; }

async function saveEditExpires() {
  if (!editingExpires.value) return;
  const target = editingExpires.value;
  const params: Record<string, string> = { id: target.id };
  if (editExpiresType.value === "never") {
    // Empty string clears the column server-side.
    params.expires = "";
  } else {
    const ms = computeExpiresMs(
      editExpiresType.value,
      editExpiresDays.value,
      editExpiresAt.value,
    );
    if (ms === undefined) {
      showToast(t("shares.invalidExpires"), "error");
      return;
    }
    params.expires = String(ms);
  }
  try {
    const xml = await authFetch("updateShare", params);
    if (failed(xml)) throw new Error(extractError(xml) || "update failed");
    showToast(t("shares.updated"));
    closeEditExpires();
    await load();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("shares.updateFailed")}: ${msg}`, "error");
  }
}

// ===========================================================================
// Delete
// ===========================================================================
async function deleteShare(s: Share) {
  if (!confirm(t("shares.confirmDelete"))) return;
  try {
    const xml = await authFetch("deleteShare", { id: s.id });
    if (failed(xml)) throw new Error(extractError(xml) || "delete failed");
    showToast(t("shares.deleted"));
    shares.value = shares.value.filter((x) => x.id !== s.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${t("shares.deleteFailed")}: ${msg}`, "error");
  }
}

// ===========================================================================
// Copy
// ===========================================================================
async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    showToast(t("shares.copied"));
  } catch {
    showToast(t("shares.copyFailed"), "error");
  }
}

const hasShares = computed(() => shares.value.length > 0);

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="mono-label">{{ t("shares.label") }}</div>
        <h1 class="page-title">{{ t("shares.title") }}</h1>
      </div>
      <button
        :class="showForm ? 'btn-secondary' : 'btn-primary'"
        @click="showForm = !showForm; if (!showForm) resetForm();"
      >
        {{ showForm ? t("shares.cancel") : t("shares.create") }}
      </button>
    </div>

    <!-- New share form -->
    <div v-if="showForm" class="card" style="margin-bottom:1.25rem; max-width:620px">
      <div class="card-header"><span class="card-title">{{ t("shares.create") }}</span></div>
      <div style="display:flex; flex-direction:column; gap:0.9rem">
        <!-- Target type toggle -->
        <div class="form-group">
          <label class="form-label">{{ t("shares.targetType") }}</label>
          <div class="seg">
            <button
              type="button"
              :class="['seg-btn', { active: form.targetType === 'song' }]"
              @click="form.targetType = 'song'; form.targetId = ''; form.targetLabel = ''; searchResults = [];"
            >{{ t("shares.targetSong") }}</button>
            <button
              type="button"
              :class="['seg-btn', { active: form.targetType === 'album' }]"
              @click="form.targetType = 'album'; form.targetId = ''; form.targetLabel = ''; searchResults = [];"
            >{{ t("shares.targetAlbum") }}</button>
          </div>
        </div>

        <!-- Target picker -->
        <div class="form-group">
          <label class="form-label">{{ t("shares.targetSelect") }}</label>
          <div class="search-row">
            <input
              v-model="form.targetQuery"
              class="form-input"
              :placeholder="form.targetType === 'song' ? t('shares.searchSongHint') : t('shares.searchAlbumHint')"
              @keydown.enter.prevent="searchTargets"
            />
            <button class="btn-secondary" @click="searchTargets" :disabled="searching">
              {{ searching ? t("shares.searching") : t("shares.search") }}
            </button>
          </div>
          <div v-if="searchResults.length" class="search-results">
            <div
              v-for="r in searchResults"
              :key="r.id"
              class="search-result"
              :class="{ selected: form.targetId === r.id }"
              @click="pickTarget(r)"
            >
              <div class="result-label">{{ r.label }}</div>
              <div v-if="r.sub" class="result-sub">{{ r.sub }}</div>
            </div>
          </div>
          <div v-if="form.targetLabel" class="picked-label">
            <span class="mono-label">✓ {{ form.targetLabel }}</span>
          </div>
        </div>

        <!-- Description -->
        <div class="form-group">
          <label class="form-label">{{ t("shares.description") }} <span class="optional">({{ t("shares.optional") }})</span></label>
          <input v-model="form.description" class="form-input" :placeholder="t('shares.descriptionPlaceholder')" />
        </div>

        <!-- Expires -->
        <div class="form-group">
          <label class="form-label">{{ t("shares.expires") }}</label>
          <div class="seg">
            <button
              type="button"
              :class="['seg-btn', { active: form.expiresType === 'never' }]"
              @click="form.expiresType = 'never'"
            >{{ t("shares.expiresNever") }}</button>
            <button
              type="button"
              :class="['seg-btn', { active: form.expiresType === 'days' }]"
              @click="form.expiresType = 'days'"
            >{{ t("shares.expiresIn") }}</button>
            <button
              type="button"
              :class="['seg-btn', { active: form.expiresType === 'datetime' }]"
              @click="form.expiresType = 'datetime'"
            >{{ t("shares.expiresAt") }}</button>
          </div>
          <div v-if="form.expiresType === 'days'" style="margin-top:0.5rem">
            <div class="days-row">
              <input v-model.number="form.expiresDays" type="number" min="1" max="3650" class="form-input days-input" />
              <span class="mono-label">{{ t("shares.days") }}</span>
            </div>
          </div>
          <div v-if="form.expiresType === 'datetime'" style="margin-top:0.5rem">
            <input v-model="form.expiresAt" type="datetime-local" class="form-input" />
          </div>
        </div>

        <button class="btn-primary" @click="createShare">{{ t("shares.save") }}</button>
      </div>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <!-- Loading -->
    <div v-if="loading && !hasShares" class="empty-state">
      <div class="empty-state-icon">◌</div><div>{{ t("shares.loading") }}</div>
    </div>

    <!-- Empty -->
    <div v-else-if="!hasShares" class="empty-state">
      <div class="empty-state-icon">◌</div><div>{{ t("shares.empty") }}</div>
    </div>

    <!-- List -->
    <div v-else class="share-list">
      <div v-for="s in shares" :key="s.id" class="card share-card">
        <div class="share-header">
          <span class="status-badge info">SHARE</span>
          <div class="share-actions">
            <button class="btn-secondary btn-sm" @click="openEditExpires(s)">{{ t("shares.updateExpires") }}</button>
            <button class="btn-danger btn-sm" @click="deleteShare(s)">{{ t("shares.delete") }}</button>
          </div>
        </div>

        <!-- Public URL row -->
        <div class="share-url-row">
          <span class="meta-label">{{ t("shares.publicUrl") }}:</span>
          <span class="meta-value mono share-url">{{ s.url }}</span>
          <button class="link-button" @click="copyUrl(s.url)">{{ t("shares.copyUrl") }}</button>
        </div>

        <!-- Entries -->
        <div v-if="s.entries.length" class="share-entries">
          <div v-for="e in s.entries.slice(0, 5)" :key="e.id" class="share-entry">
            <span class="entry-title">{{ e.title }}</span>
            <span class="entry-meta">— {{ e.artist || t("shares.unknownArtist") }} · {{ e.album || t("shares.unknownAlbum") }}</span>
          </div>
          <div v-if="s.entries.length > 5" class="mono-label entry-more">
            +{{ s.entries.length - 5 }} {{ t("shares.moreTracks") }}
          </div>
        </div>

        <!-- Metadata -->
        <div class="share-meta">
          <div class="meta-row" v-if="s.description">
            <span class="meta-label">{{ t("shares.description") }}:</span>
            <span class="meta-value">{{ s.description }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">{{ t("shares.created") }}:</span>
            <span class="meta-value mono">{{ fmtDate(s.created) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">{{ t("shares.expiresLabel") }}:</span>
            <span class="meta-value mono">{{ s.expires ? fmtDate(s.expires) : t("shares.neverExpires") }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">{{ t("shares.viewCount") }}:</span>
            <span class="meta-value mono">{{ s.visitCount }}</span>
          </div>
        </div>

        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
      </div>
    </div>

    <!-- Update expires modal -->
    <div v-if="editingExpires" class="modal-backdrop" @click.self="closeEditExpires">
      <div class="modal">
        <div class="modal-title">{{ t("shares.updateExpires") }}</div>
        <div style="display:flex; flex-direction:column; gap:0.8rem">
          <div class="form-group">
            <label class="form-label">{{ t("shares.expires") }}</label>
            <div class="seg">
              <button
                type="button"
                :class="['seg-btn', { active: editExpiresType === 'never' }]"
                @click="editExpiresType = 'never'"
              >{{ t("shares.expiresNever") }}</button>
              <button
                type="button"
                :class="['seg-btn', { active: editExpiresType === 'days' }]"
                @click="editExpiresType = 'days'"
              >{{ t("shares.expiresIn") }}</button>
              <button
                type="button"
                :class="['seg-btn', { active: editExpiresType === 'datetime' }]"
                @click="editExpiresType = 'datetime'"
              >{{ t("shares.expiresAt") }}</button>
            </div>
          </div>
          <div v-if="editExpiresType === 'days'" class="days-row">
            <input v-model.number="editExpiresDays" type="number" min="1" max="3650" class="form-input days-input" />
            <span class="mono-label">{{ t("shares.days") }}</span>
          </div>
          <input
            v-if="editExpiresType === 'datetime'"
            v-model="editExpiresAt"
            type="datetime-local"
            class="form-input"
          />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeEditExpires">{{ t("shares.cancel") }}</button>
          <button class="btn-primary" @click="saveEditExpires">{{ t("shares.save") }}</button>
        </div>
        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.share-list { display: flex; flex-direction: column; gap: 0.9rem; }
.share-card {
  display: flex; flex-direction: column; gap: 0.65rem;
  position: relative;
}
.share-header {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
}
.share-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: flex-end; }

.share-url-row {
  display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap;
  padding: 0.45rem 0.6rem;
  background: var(--color-bg-tertiary);
  border-left: 2px solid var(--color-accent-primary);
}
.share-url {
  color: var(--color-accent-primary);
  word-break: break-all;
  flex: 1; min-width: 0;
}

.share-entries {
  display: flex; flex-direction: column; gap: 0.2rem;
  padding-left: 0.6rem;
  border-left: 1px dotted var(--color-border-subtle);
}
.share-entry {
  font-size: var(--fs-sm);
  display: flex; gap: 0.4rem; flex-wrap: wrap;
}
.entry-title { color: var(--color-text-primary); font-weight: 600; }
.entry-meta { color: var(--color-text-secondary); font-family: var(--font-mono); font-size: var(--fs-xs); }
.entry-more { padding-top: 0.2rem; color: var(--color-text-muted); }

.share-meta {
  display: flex; flex-direction: column; gap: 0.3rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
.meta-row { display: flex; gap: 0.45rem; flex-wrap: wrap; }
.meta-label {
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.meta-value { color: var(--color-text-primary); word-break: break-all; }
.meta-value.mono { font-family: var(--font-mono); }

.optional {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
  letter-spacing: 0.05em;
}
.link-button {
  background: none; border: none; padding: 0; cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  color: var(--color-accent-primary);
  text-decoration: underline dotted;
}
.link-button:hover { color: var(--color-text-primary); }

/* segmented toggle */
.seg { display: inline-flex; border: 1px solid var(--color-border-subtle); }
.seg-btn {
  background: none; border: none; padding: 0.35rem 0.85rem; cursor: pointer;
  font-family: var(--font-mono); font-size: var(--fs-xs);
  letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--color-text-secondary);
  border-right: 1px solid var(--color-border-subtle);
}
.seg-btn:last-child { border-right: none; }
.seg-btn:hover { color: var(--color-text-primary); }
.seg-btn.active {
  background: var(--color-accent-dim);
  color: var(--color-accent-primary);
}

/* search */
.search-row { display: flex; gap: 0.5rem; }
.search-row .form-input { flex: 1; }
.search-results {
  margin-top: 0.4rem;
  max-height: 260px; overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-secondary);
}
.search-result {
  padding: 0.45rem 0.7rem;
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
}
.search-result:last-child { border-bottom: none; }
.search-result:hover { background: var(--color-bg-tertiary); }
.search-result.selected { background: var(--color-accent-dim); }
.result-label { color: var(--color-text-primary); font-weight: 600; font-size: var(--fs-sm); }
.result-sub {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  margin-top: 0.1rem;
}
.picked-label { margin-top: 0.4rem; color: var(--color-accent-primary); }

.days-row { display: flex; align-items: center; gap: 0.5rem; }
.days-input { max-width: 100px; }
</style>
