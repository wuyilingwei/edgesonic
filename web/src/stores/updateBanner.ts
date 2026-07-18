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
// build mismatch we flip `available` to true and the
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
  buildTime: string | null;
}

function hasUpdate(initial: VersionPayload, latest: VersionPayload): boolean {
  return initial.version !== latest.version || (
    latest.buildTime !== null && initial.buildTime !== latest.buildTime
  );
}

export const useUpdateBanner = defineStore("updateBanner", () => {
  const initial = ref<VersionPayload | null>(null);
  const latest = ref<VersionPayload | null>(null);
  const dismissed = ref(false);

  const available = computed(() => {
    if (!initial.value || !latest.value) return false;
    if (dismissed.value) return false;
    return hasUpdate(initial.value, latest.value);
  });

  function notify(payload: VersionPayload) {
    if (!initial.value) {
      initial.value = payload;
      latest.value = payload;
      return;
    }
    latest.value = payload;
    if (hasUpdate(initial.value, payload)) {
      refresh();
    }
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
