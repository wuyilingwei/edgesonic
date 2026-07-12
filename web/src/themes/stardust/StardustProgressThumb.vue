<script setup lang="ts">
// Registered as `progressThumb` in ./index.ts — PlayerBar.vue mounts this
// generically via `<component :is="theme?.progressThumb">` inside its own
// `.pb-progress-thumb` (which handles positioning/dragging; this component
// only owns the visual inside it). The outer element pins this canvas to
// the play position; the Metatron solid spins around its own centre inside
// it (real 3D render, same module as the Stardust background forms).
import { onBeforeUnmount } from "vue";
import { startMetatron } from "../../lib/metatron3d";

let stop: (() => void) | null = null;
function mount(el: unknown) {
  stop?.();
  stop = null;
  if (el instanceof HTMLCanvasElement) stop = startMetatron(el, { size: 24, spinSeconds: 5 });
}
onBeforeUnmount(() => stop?.());
</script>

<template>
  <canvas class="thumb-metatron" :ref="mount"></canvas>
</template>

<style>
:root[data-theme="stardust"] .thumb-metatron {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
