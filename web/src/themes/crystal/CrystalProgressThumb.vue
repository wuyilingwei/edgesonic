
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { activeTheme } from "../../theme";
import { mountCrystalThumb } from "./background";
import { elementVisualFor } from "../elements/catalog";

const hostEl = ref<HTMLElement | null>(null);
let cleanup: (() => void) | null = null;

function remount() {
  cleanup?.();
  cleanup = null;
  const v = elementVisualFor(activeTheme.value);
  if (v && hostEl.value) cleanup = mountCrystalThumb(hostEl.value, { color: v.color, halo: v.halo, shape: v.shape });
}

onMounted(remount);
watch(activeTheme, remount);
onBeforeUnmount(() => { cleanup?.(); cleanup = null; });
</script>

<template>
  <span ref="hostEl" class="thumb-crystal" aria-hidden="true"></span>
</template>

<style>
.thumb-crystal { position: absolute; inset: 0; display: block; }
.crystal-thumb-canvas {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  filter: drop-shadow(0 0 5px color-mix(in srgb, var(--color-accent-primary) 82%, transparent));
}
</style>
