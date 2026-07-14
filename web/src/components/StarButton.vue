<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAuth } from "../api";

type StarKind = "song" | "album" | "artist";

const props = defineProps<{
  id: string;
  kind: StarKind;
  starred: boolean;
}>();

const emit = defineEmits<{
  "update:starred": [value: boolean];
  error: [];
}>();

const { t } = useI18n();
const { authFetch } = useAuth();
const active = ref(props.starred);
const busy = ref(false);

watch(() => props.starred, (value) => {
  if (!busy.value) active.value = value;
});

function params(): Record<string, string> {
  const key = props.kind === "song" ? "id" : props.kind === "album" ? "albumId" : "artistId";
  return { [key]: props.id };
}

async function toggle() {
  if (busy.value) return;
  const next = !active.value;
  active.value = next;
  busy.value = true;
  try {
    const xml = await authFetch(next ? "star" : "unstar", params());
    if (/status="failed"/.test(xml)) throw new Error("star update failed");
    emit("update:starred", next);
  } catch {
    active.value = props.starred;
    emit("error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    class="star-button"
    :class="{ active, busy }"
    :aria-pressed="active"
    :aria-label="active ? t('library.unlike') : t('library.like')"
    :title="active ? t('library.unlike') : t('library.like')"
    :disabled="busy"
    @click.stop="toggle"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  </button>
</template>

<style scoped>
.star-button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--color-border-subtle);
  border-radius: 2px;
  background: rgba(10, 10, 11, 0.72);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s, opacity 0.15s;
}
.star-button svg { width: 15px; height: 15px; }
.star-button:hover:not(:disabled) { color: var(--color-accent-primary); background: var(--color-bg-tertiary); }
.star-button.active { color: var(--color-accent-primary); border-color: var(--color-accent-dim); }
.star-button.busy { opacity: 0.55; cursor: wait; }
</style>
