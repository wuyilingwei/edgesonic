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

//
// The poller in main.ts calls notify() with the latest build metadata from
// /edgesonic/version. On the first call we capture the baseline; on any later
// build mismatch we auto-refresh ONCE. If after that reload the deployed
// metadata still differs from the loaded bundle (e.g. local `wrangler dev`
// without EDGESONIC_VERSION, --no-build with stale web/dist, or missing
// --var on deploy), we stop auto-refreshing and show a banner so the user
// decides — this prevents the infinite reload loop.
//
// The "already auto-refreshed" flag is kept in sessionStorage so it survives a
// single reload but is cleared when the tab closes; a fresh session can still
// auto-refresh on a real deploy.
//
// Dismissal is per-session: clicking "Later" sets dismissed=true; we stay
// silent until the user navigates away or refreshes. We deliberately do NOT
// persist dismissal in localStorage — if they ignore the banner and reload
// for any reason, that's the desired outcome (load latest bundle).
import { defineStore } from "pinia";
import { ref, computed } from "vue";

interface VersionPayload {
  version: string;
  buildTime: string | null;
}

const AUTO_REFRESH_KEY = "edgesonic:auto-refreshed";

function hasUpdate(initial: VersionPayload, latest: VersionPayload): boolean {
  return initial.version !== latest.version || (
    latest.buildTime !== null && initial.buildTime !== latest.buildTime
  );
}

export const useUpdateBanner = defineStore("updateBanner", () => {
  const initial = ref<VersionPayload | null>(null);
  const latest = ref<VersionPayload | null>(null);
  const dismissed = ref(false);
  // True after we've already auto-refreshed once this session. Survives
  // reload via sessionStorage so a persistently-mismatched server cannot
  // loop the page forever.
  const autoRefreshed = ref(
    typeof sessionStorage !== "undefined" && sessionStorage.getItem(AUTO_REFRESH_KEY) === "1"
  );

  const available = computed(() => {
    if (!initial.value || !latest.value) return false;
    if (dismissed.value) return false;
    return hasUpdate(initial.value, latest.value);
  });

  // Shown when we already auto-refreshed once but the server still reports a
  // different build — a real update may have landed during the reload, or
  // the server keeps returning mismatched metadata. Either way, let the user
  // decide instead of looping.
  const showStale = computed(() => {
    if (!initial.value || !latest.value) return false;
    if (dismissed.value) return false;
    return autoRefreshed.value && hasUpdate(initial.value, latest.value);
  });

  function notify(payload: VersionPayload) {
    if (!initial.value) {
      initial.value = payload;
      latest.value = payload;
      return;
    }
    latest.value = payload;
    if (hasUpdate(initial.value, payload) && !autoRefreshed.value) {
      markAutoRefreshed();
      refresh();
    }
  }

  function markAutoRefreshed() {
    autoRefreshed.value = true;
    try { sessionStorage.setItem(AUTO_REFRESH_KEY, "1"); } catch { /* private mode */ }
  }

  function dismiss() {
    dismissed.value = true;
  }

  function refresh() {
    // Manual click: always allow, regardless of autoRefreshed.
    window.location.reload();
  }

  return { initial, latest, dismissed, autoRefreshed, available, showStale, notify, dismiss, refresh };
});
