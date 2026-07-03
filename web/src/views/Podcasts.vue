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
// 063 — Podcast subscriptions UI
// ----------------------------------------------------------------------------
// Mirrors Sources.vue card pattern: a header bar with primary actions on the
// right, then a 2-column grid of channel cards. Each card shows up to the 5
// most recent episodes inline; "expand all" reveals the rest. Admin-only
// surface (download / delete) is hidden for non-admins via `isAdmin`; the
// backend additionally enforces `manage_podcasts` so a determined user gets
// a Subsonic error rather than silent failure.
// ----------------------------------------------------------------------------
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth, parseXmlAttrs, formatDuration } from "../api";

const { t } = useI18n();
const { isAdmin, authFetch, coverArtUrl } = useAuth();

type ChannelStatus = "new" | "completed" | "error" | string;
type EpisodeStatus = "new" | "downloading" | "completed" | "error" | string;

interface Episode {
  id: string;
  channelId: string;
  title: string;
  description: string;
  publishDate: string;
  status: EpisodeStatus;
  duration: number;
  bitRate: number;
  size: number;
  suffix: string;
  contentType: string;
  coverArt: string;
}

interface Channel {
  id: string;
  url: string;
  title: string;
  description: string;
  coverArt: string;
  status: ChannelStatus;
  errorMessage: string;
  episodes: Episode[];
}

// === State ===
const channels = ref<Channel[]>([]);
const loading = ref(false);
const expanded = ref<Set<string>>(new Set());

// Add-channel form
const showAddForm = ref(false);
const newChannelUrl = ref("");
const addingChannel = ref(false);

// Refresh button cooldown — backend uses ctx.waitUntil so the immediate
// response says nothing useful; we lock for 5s then reload.
const refreshing = ref(false);

// Per-episode busy lock for download/delete buttons. Keyed by episode id.
const epBusy = ref<Set<string>>(new Set());

// Per-channel busy lock for delete.
const chBusy = ref<Set<string>>(new Set());

// Toast
const toast = ref({ show: false, msg: "", type: "success" as "success" | "error" });
function showToast(msg: string, type: "success" | "error" = "success") {
  toast.value = { show: true, msg, type };
  setTimeout(() => { toast.value.show = false; }, 3000);
}

// === XML helpers (Subsonic ok/failed envelope) ===
function isOk(xml: string): boolean {
  return /status="ok"/.test(xml);
}
function errorMessage(xml: string): string {
  const e = parseXmlAttrs(xml, "error")[0];
  return e?.message || t("podcasts.errorGeneric");
}

// === Load ===
async function loadAll() {
  loading.value = true;
  try {
    const xml = await authFetch("getPodcasts", { includeEpisodes: "true" });
    if (!isOk(xml)) {
      showToast(errorMessage(xml), "error");
      channels.value = [];
      return;
    }
    // <channel> is a parent of <episode>; parseXmlAttrs uses a regex that only
    // captures up to the first `>`, so we get channel-attrs cleanly. Episodes
    // are then parsed as a flat list and bucketed by channelId.
    const chAttrs = parseXmlAttrs(xml, "channel");
    const epAttrs = parseXmlAttrs(xml, "episode");

    const epByChannel = new Map<string, Episode[]>();
    for (const e of epAttrs) {
      const ep: Episode = {
        id: e.id || "",
        channelId: e.channelId || "",
        title: e.title || "",
        description: e.description || "",
        publishDate: e.publishDate || "",
        status: (e.status || "new") as EpisodeStatus,
        duration: e.duration ? parseInt(e.duration, 10) || 0 : 0,
        bitRate: e.bitRate ? parseInt(e.bitRate, 10) || 0 : 0,
        size: e.size ? parseInt(e.size, 10) || 0 : 0,
        suffix: e.suffix || "",
        contentType: e.contentType || "",
        coverArt: e.coverArt || "",
      };
      const arr = epByChannel.get(ep.channelId);
      if (arr) arr.push(ep);
      else epByChannel.set(ep.channelId, [ep]);
    }
    // Newest episode first (publishDate desc; lexical ISO 8601 sort works).
    for (const arr of epByChannel.values()) {
      arr.sort((a, b) => (b.publishDate || "").localeCompare(a.publishDate || ""));
    }

    channels.value = chAttrs.map((c) => {
      const id = c.id || "";
      return {
        id,
        url: c.url || "",
        title: c.title || c.url || id,
        description: c.description || "",
        coverArt: c.coverArt || "",
        status: (c.status || "new") as ChannelStatus,
        errorMessage: c.errorMessage || "",
        episodes: epByChannel.get(id) || [],
      };
    });
  } catch (e) {
    channels.value = [];
    showToast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    loading.value = false;
  }
}

// === Actions ===
async function addChannel() {
  const url = newChannelUrl.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    showToast(t("podcasts.urlInvalid"), "error");
    return;
  }
  addingChannel.value = true;
  try {
    const xml = await authFetch("createPodcastChannel", { url });
    if (!isOk(xml)) throw new Error(errorMessage(xml));
    showToast(t("podcasts.subscribed"));
    showAddForm.value = false;
    newChannelUrl.value = "";
    // Backend kicks off refresh in ctx.waitUntil — channel appears immediately
    // with status="new", episodes populate on next poll.
    await loadAll();
    // Reload again shortly so the RSS fetch result shows up without manual click.
    setTimeout(() => { void loadAll(); }, 4000);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    addingChannel.value = false;
  }
}

async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const xml = await authFetch("refreshPodcasts");
    if (!isOk(xml)) throw new Error(errorMessage(xml));
    showToast(t("podcasts.refreshTriggered"));
    // Backend runs the refresh in ctx.waitUntil — wait a bit then reload.
    setTimeout(() => { void loadAll(); }, 4000);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    setTimeout(() => { refreshing.value = false; }, 5000);
  }
}

async function deleteChannel(c: Channel) {
  if (!confirm(t("podcasts.confirmDeleteChannel", { title: c.title }))) return;
  chBusy.value.add(c.id);
  try {
    const xml = await authFetch("deletePodcastChannel", { id: c.id });
    if (!isOk(xml)) throw new Error(errorMessage(xml));
    showToast(t("podcasts.channelDeleted"));
    channels.value = channels.value.filter((x) => x.id !== c.id);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    chBusy.value.delete(c.id);
  }
}

async function downloadEpisode(c: Channel, ep: Episode) {
  if (epBusy.value.has(ep.id)) return;
  epBusy.value.add(ep.id);
  try {
    // Optimistic flip — server side does the same, but we want the badge to
    // update instantly.
    ep.status = "downloading";
    const xml = await authFetch("downloadPodcastEpisode", { id: ep.id });
    if (!isOk(xml)) throw new Error(errorMessage(xml));
    showToast(t("podcasts.downloadTriggered"));
    // R2 write runs in ctx.waitUntil; reload after a few seconds so the
    // status flips to completed/error.
    setTimeout(() => { void loadAll(); }, 4000);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "error");
    ep.status = "error";
  } finally {
    epBusy.value.delete(ep.id);
    void c; // unused — kept for signature symmetry with deleteEpisode
  }
}

async function deleteEpisode(c: Channel, ep: Episode) {
  if (!confirm(t("podcasts.confirmDeleteEpisode", { title: ep.title || ep.id }))) return;
  if (epBusy.value.has(ep.id)) return;
  epBusy.value.add(ep.id);
  try {
    const xml = await authFetch("deletePodcastEpisode", { id: ep.id });
    if (!isOk(xml)) throw new Error(errorMessage(xml));
    showToast(t("podcasts.episodeDeleted"));
    c.episodes = c.episodes.filter((x) => x.id !== ep.id);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    epBusy.value.delete(ep.id);
  }
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function visibleEpisodes(c: Channel): Episode[] {
  return expanded.value.has(c.id) ? c.episodes : c.episodes.slice(0, 5);
}

function formatPublished(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function statusLabel(s: EpisodeStatus): string {
  if (s === "new") return t("podcasts.status.new");
  if (s === "downloading") return t("podcasts.status.downloading");
  if (s === "completed") return t("podcasts.status.completed");
  if (s === "error") return t("podcasts.status.error");
  return s;
}

const totalChannels = computed(() => channels.value.length);

// === Lifecycle ===
let pollHandle: number | null = null;
const POLL_MS = 30_000;

function startPolling(): void {
  if (pollHandle !== null) return;
  pollHandle = window.setInterval(() => { void loadAll(); }, POLL_MS);
}

function stopPolling(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

// P6 — pause the poll while the tab is hidden; resume + immediately refresh
// when it becomes visible again. Mirrors Dashboard.vue onActivityVisibility.
function onVisibilityChange(): void {
  if (document.hidden) {
    stopPolling();
  } else {
    void loadAll();
    startPolling();
  }
}

onMounted(async () => {
  await loadAll();
  // Light background polling so a download/refresh kicked off elsewhere
  // eventually reflects in the UI. 30s keeps cost negligible.
  startPolling();
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="mono-label">// {{ t("podcasts.label") }}</div>
        <h1 class="page-title">{{ t("podcasts.title") }}</h1>
        <div class="page-subtitle">{{ t("podcasts.subtitle", { n: totalChannels }) }}</div>
      </div>
      <div class="header-actions">
        <button v-if="isAdmin"
                class="btn-secondary"
                :disabled="refreshing"
                @click="refreshAll">
          {{ refreshing ? t("podcasts.refreshing") : t("podcasts.refreshAll") }}
        </button>
        <button v-if="isAdmin"
                :class="showAddForm ? 'btn-secondary' : 'btn-primary'"
                @click="showAddForm = !showAddForm">
          {{ showAddForm ? t("common.cancel") : t("podcasts.subscribe") }}
        </button>
      </div>
    </div>

    <!-- Subscribe form -->
    <div v-if="showAddForm && isAdmin" class="card add-form">
      <div class="card-header"><span class="card-title">{{ t("podcasts.newChannel") }}</span></div>
      <div class="form-group">
        <label class="form-label">{{ t("podcasts.url") }}</label>
        <input v-model="newChannelUrl"
               class="form-input"
               placeholder="https://example.com/feed.rss"
               @keydown.enter="addChannel" />
        <span class="field-hint">{{ t("podcasts.urlHint") }}</span>
      </div>
      <div class="form-actions">
        <button class="btn-primary"
                :disabled="addingChannel || !newChannelUrl.trim()"
                @click="addChannel">
          {{ addingChannel ? t("podcasts.subscribing") : t("podcasts.subscribe") }}
        </button>
      </div>
      <div class="corner corner-tl"></div>
      <div class="corner corner-br"></div>
    </div>

    <!-- Channels grid -->
    <div v-if="loading && !channels.length" class="empty-state">
      <div class="empty-state-icon">◌</div>
      <div>{{ t("common.loading") }}</div>
    </div>
    <div v-else-if="!channels.length" class="empty-state">
      <div class="empty-state-icon">◌</div>
      <div>{{ t("podcasts.empty") }}</div>
    </div>

    <div v-else class="channels-grid">
      <div v-for="c in channels" :key="c.id" class="card channel-card">
        <!-- Channel header -->
        <div class="channel-head">
          <div class="channel-cover">
            <img v-if="c.coverArt"
                 :src="coverArtUrl(c.coverArt, 192)"
                 :alt="c.title"
                 loading="lazy" />
            <span v-else class="channel-cover-fallback">◉</span>
          </div>
          <div class="channel-info">
            <div class="channel-title-row">
              <span class="channel-title">{{ c.title }}</span>
              <span v-if="c.status === 'error'"
                    class="status-badge error"
                    :title="c.errorMessage">{{ t("podcasts.channelError") }}</span>
              <span v-else-if="c.status === 'new'"
                    class="status-badge info">{{ t("podcasts.channelSyncing") }}</span>
            </div>
            <div class="channel-url">{{ c.url }}</div>
            <div v-if="c.description" class="channel-desc">{{ c.description }}</div>
          </div>
          <div class="channel-actions">
            <button v-if="isAdmin"
                    class="btn-danger btn-sm"
                    :disabled="chBusy.has(c.id)"
                    @click="deleteChannel(c)">
              {{ t("podcasts.deleteChannel") }}
            </button>
          </div>
        </div>

        <!-- Episode list -->
        <div v-if="c.episodes.length" class="episodes">
          <div class="episodes-head">
            <span class="episodes-title">{{ t("podcasts.episodes") }}</span>
            <span class="episodes-count">{{ c.episodes.length }}</span>
          </div>
          <div class="episode-row" v-for="ep in visibleEpisodes(c)" :key="ep.id">
            <div class="episode-main">
              <div class="episode-title">{{ ep.title || ep.id }}</div>
              <div class="episode-meta">
                <span class="ep-meta-item">{{ t("podcasts.published") }}: {{ formatPublished(ep.publishDate) }}</span>
                <span v-if="ep.duration" class="ep-meta-item">{{ formatDuration(ep.duration) }}</span>
                <span v-if="ep.suffix" class="ep-meta-item">{{ ep.suffix.toUpperCase() }}</span>
                <span class="ep-meta-item">
                  <span :class="['status-pill', `status-pill-${ep.status}`]">
                    <span v-if="ep.status === 'downloading'" class="ep-spinner" aria-hidden="true"></span>
                    {{ statusLabel(ep.status) }}
                  </span>
                </span>
              </div>
            </div>
            <div v-if="isAdmin" class="episode-actions">
              <button v-if="ep.status !== 'completed' && ep.status !== 'downloading'"
                      class="btn-secondary btn-sm"
                      :disabled="epBusy.has(ep.id)"
                      @click="downloadEpisode(c, ep)">
                {{ t("podcasts.download") }}
              </button>
              <button class="btn-danger btn-sm"
                      :disabled="epBusy.has(ep.id)"
                      @click="deleteEpisode(c, ep)">
                {{ t("podcasts.deleteEpisode") }}
              </button>
            </div>
          </div>
          <button v-if="c.episodes.length > 5"
                  class="link-button"
                  @click="toggleExpand(c.id)">
            {{ expanded.has(c.id) ? t("podcasts.collapse") : t("podcasts.expandAll", { n: c.episodes.length }) }}
          </button>
        </div>
        <div v-else class="episodes-empty">{{ t("podcasts.episodesEmpty") }}</div>

        <div class="corner corner-tl"></div>
        <div class="corner corner-br"></div>
      </div>
    </div>

    <div v-if="toast.show" :class="['toast', `toast-${toast.type}`]">{{ toast.msg }}</div>
  </div>
</template>

<style scoped>
.page { max-width: 1100px; }
.page-subtitle {
  margin-top: 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}
.header-actions { display: flex; gap: 0.5rem; }

.add-form {
  margin-bottom: 1.25rem;
  max-width: 600px;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.form-actions { display: flex; justify-content: flex-end; }
.field-hint {
  display: block;
  margin-top: 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}

.channels-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 1rem;
}

.channel-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.channel-head {
  display: grid;
  grid-template-columns: 96px 1fr auto;
  gap: 0.85rem;
  align-items: start;
}
.channel-cover {
  width: 96px;
  height: 96px;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
}
.channel-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.channel-cover-fallback {
  font-size: 2rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}
.channel-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.channel-title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.channel-title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: 0.01em;
  word-break: break-word;
}
.channel-url {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-accent-primary);
  word-break: break-all;
}
.channel-desc {
  font-size: var(--fs-sm);
  color: var(--color-text-secondary);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.channel-actions { display: flex; flex-direction: column; gap: 0.3rem; align-items: flex-end; }

/* Episodes */
.episodes {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--color-border-subtle);
}
.episodes-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: 0.2rem;
}
.episodes-count { color: var(--color-text-secondary); }
.episodes-empty {
  padding-top: 0.5rem;
  border-top: 1px dashed var(--color-border-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}

.episode-row {
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
  padding: 0.45rem 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
}
.episode-row:last-of-type { border-bottom: none; }
.episode-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.episode-title {
  font-size: var(--fs-sm);
  color: var(--color-text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.episode-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--color-text-muted);
}
.ep-meta-item { display: inline-flex; align-items: center; gap: 0.3rem; }

.episode-actions {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  border: 1px solid var(--color-border-subtle);
}
.status-pill-new {
  color: var(--color-text-secondary);
}
.status-pill-downloading {
  color: var(--color-accent-primary);
  border-color: var(--color-accent-primary);
}
.status-pill-completed {
  color: var(--color-success, #4ade80);
  border-color: rgba(74, 222, 128, 0.4);
}
.status-pill-error {
  color: var(--color-error, #f87171);
  border-color: rgba(248, 113, 113, 0.4);
}
.ep-spinner {
  display: inline-block;
  width: 0.7em;
  height: 0.7em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: epSpin 0.85s linear infinite;
}
@keyframes epSpin {
  to { transform: rotate(360deg); }
}

.link-button {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 0.3rem 0;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.05em;
  color: var(--color-accent-primary);
  text-decoration: underline dotted;
}
.link-button:hover { color: var(--color-text-primary); }

@media (max-width: 720px) {
  .channel-head {
    grid-template-columns: 64px 1fr;
  }
  .channel-actions {
    grid-column: 1 / -1;
    flex-direction: row;
    justify-content: flex-end;
  }
  .channel-cover { width: 64px; height: 64px; }
  .episode-row { flex-direction: column; }
  .episode-actions { width: 100%; justify-content: flex-end; }
}
</style>
