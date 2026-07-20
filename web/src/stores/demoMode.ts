// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Demo mode store. Mirrors the `demoMode` flag returned by /edgesonic/version
// so any component can render demo-aware UI (locked toggles, reset banner,
// demo badge). The flag is populated by main.ts during the version probe and
// defaults to false until the first successful probe.

import { defineStore } from "pinia";
import { ref } from "vue";

export const useDemoMode = defineStore("demoMode", () => {
  const enabled = ref(false);
  const allowAllFileTypes = ref(false);
  function setEnabled(v: boolean) {
    enabled.value = !!v;
  }
  function setAllowAllFileTypes(v: boolean) {
    allowAllFileTypes.value = !!v;
  }
  return { enabled, allowAllFileTypes, setEnabled, setAllowAllFileTypes };
});