// 081 — Update banner store.
//
// The poller in main.ts calls notify() with the latest version+startedAt
// payload from /edgesonic/version. On the first call we capture the baseline;
// on any subsequent mismatch (worker redeployed → WORKER_VERSION bumped or
// isolate restarted → new startedAt) we flip `available` to true and the
// UpdateBanner component renders itself.
//
// Dismissal is per-session: clicking "Later" sets dismissed=true; we stay
// silent until the user navigates away or refreshes. We deliberately do NOT
// persist dismissal in localStorage — if they ignore the banner and reload
// for any reason, that's the desired outcome (load latest bundle).
import { defineStore } from "pinia";
import { ref, computed } from "vue";

interface VersionPayload {
  version: string;
  startedAt: string;
}

export const useUpdateBanner = defineStore("updateBanner", () => {
  const initial = ref<VersionPayload | null>(null);
  const latest = ref<VersionPayload | null>(null);
  const dismissed = ref(false);

  const available = computed(() => {
    if (!initial.value || !latest.value) return false;
    if (dismissed.value) return false;
    return (
      initial.value.version !== latest.value.version ||
      initial.value.startedAt !== latest.value.startedAt
    );
  });

  function notify(payload: VersionPayload) {
    if (!initial.value) {
      initial.value = payload;
      latest.value = payload;
      return;
    }
    latest.value = payload;
  }

  function dismiss() {
    dismissed.value = true;
  }

  function refresh() {
    // Use replace so the back-button doesn't return to a half-broken state.
    window.location.reload();
  }

  return { initial, latest, dismissed, available, notify, dismiss, refresh };
});
