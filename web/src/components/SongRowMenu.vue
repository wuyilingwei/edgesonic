
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";
import Icon from "./Icon.vue";

const props = defineProps<{
  songId: string;
  title: string;
  starred: boolean;
  open: boolean;
  isAdmin: boolean;
}>();
const emit = defineEmits<{
  toggle: [];
  close: [];
  edit: [];
  share: [];
  addPlaylist: [];
  "update:starred": [value: boolean];
  error: [];
}>();

const { t } = useI18n();
const { authFetch, downloadUrl } = useAuth();
const starBusy = ref(false);

function pick(action: "edit" | "share" | "addPlaylist") {
  // emit()'s per-event overloads don't distribute over a union-typed
  // argument, so dispatch with a literal in each branch instead of
  // `emit(action)` directly.
  if (action === "edit") emit("edit");
  else if (action === "share") emit("share");
  else emit("addPlaylist");
  emit("close");
}

async function toggleStar() {
  if (starBusy.value) return;
  const next = !props.starred;
  starBusy.value = true;
  try {
    const xml = await authFetch(next ? "star" : "unstar", { id: props.songId });
    if (/status="failed"/.test(xml)) throw new Error("star update failed");
    emit("update:starred", next);
    emit("close");
  } catch {
    emit("error");
  } finally {
    starBusy.value = false;
  }
}
</script>

<template>
  <div class="row-menu-wrap" @click.stop>
    <button class="row-menu-btn" :title="t('library.moreActions')" @click="emit('toggle')"><Icon name="dot" /></button>
    <div v-if="open" class="row-menu">
      <button class="row-menu-item row-menu-like" :disabled="starBusy" @click="toggleStar"><Icon name="star" /> {{ props.starred ? t("library.unlike") : t("library.like") }}</button>
      <button v-if="props.isAdmin" class="row-menu-item" @click="pick('edit')"><Icon name="edit" /> {{ t("library.editSong") }}</button>
      <button class="row-menu-item" @click="pick('share')"><Icon name="up" /> {{ t("library.share") }}</button>
      <button class="row-menu-item" @click="pick('addPlaylist')"><Icon name="check" /> {{ t("library.addToPlaylist") }}</button>
      <a class="row-menu-item" :href="downloadUrl(props.songId)" :download="props.title" @click="emit('close')">{{ t("library.download") }}</a>
    </div>
  </div>
</template>

<style scoped>
.row-menu-wrap { position: relative; display: flex; align-items: center; justify-content: center; }
.row-menu-btn {
  background: none; border: none; cursor: pointer;
  color: var(--color-text-muted); font-size: var(--fs-md);
  padding: 0 0.35rem; opacity: 0.5;
  transition: opacity 0.15s, color 0.15s;
}
.row-menu-btn:hover { color: var(--color-accent-primary); }
.row-menu {
  position: absolute;
  top: 100%; right: 0;
  z-index: 20;
  min-width: 160px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  padding: 0.25rem 0;
}
.row-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.4rem 0.75rem;
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: var(--fs-sm);
  font-family: inherit;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
.row-menu-item:hover { background: var(--color-bg-tertiary); color: var(--color-accent-primary); }
.row-menu-like { display: none; }
@media (max-width: 768px) { .row-menu-like { display: block; } }
</style>
