<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
// Centralized SVG icon component — replaces Unicode pictographs used in UI.
// Icons are simple stroked/filled paths sized by currentColor.
import { computed, h } from "vue";

const props = defineProps<{ name: string; size?: string | number; label?: string }>();

const sizeStr = computed(() => {
  if (props.size === undefined) return "1em";
  return typeof props.size === "number" ? `${props.size}px` : props.size;
});

// Each icon's inner SVG nodes (as vnode arrays for reliability).
const ICONS: Record<string, () => ReturnType<typeof h>[]> = {
  check: () => [h("path", { d: "M3.5 8.5l3 3 6-7", stroke: "currentColor", "stroke-width": 1.5, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" })],
  cross: () => [h("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", "stroke-width": 1.5, fill: "none", "stroke-linecap": "round" })],
  warn: () => [
    h("path", { d: "M8 1.5L15 14H1L8 1.5z", stroke: "currentColor", "stroke-width": 1.2, fill: "none", "stroke-linejoin": "round" }),
    h("path", { d: "M8 6.5v3M8 11.5v0.5", stroke: "currentColor", "stroke-width": 1.2, "stroke-linecap": "round" }),
  ],
  info: () => [
    h("circle", { cx: 8, cy: 8, r: 6.5, stroke: "currentColor", "stroke-width": 1.2, fill: "none" }),
    h("path", { d: "M8 7v4M8 5v0.4", stroke: "currentColor", "stroke-width": 1.2, "stroke-linecap": "round" }),
  ],
  ban: () => [
    h("circle", { cx: 8, cy: 8, r: 6.5, stroke: "currentColor", "stroke-width": 1.2, fill: "none" }),
    h("path", { d: "M3.5 3.5l9 9", stroke: "currentColor", "stroke-width": 1.2, "stroke-linecap": "round" }),
  ],
  flag: () => [h("path", { d: "M3 14V2M3 2.5h10l-2 3 2 3H3", stroke: "currentColor", "stroke-width": 1.2, fill: "none", "stroke-linejoin": "round" })],
  lock: () => [
    h("rect", { x: 3, y: 7, width: 10, height: 7, rx: 1, stroke: "currentColor", "stroke-width": 1.2, fill: "none" }),
    h("path", { d: "M5 7V5a3 3 0 016 0v2", stroke: "currentColor", "stroke-width": 1.2, fill: "none" }),
  ],
  search: () => [
    h("circle", { cx: 7, cy: 7, r: 4.5, stroke: "currentColor", "stroke-width": 1.2, fill: "none" }),
    h("path", { d: "M10.5 10.5L14 14", stroke: "currentColor", "stroke-width": 1.2, "stroke-linecap": "round" }),
  ],
  music: () => [h("path", { d: "M13 2v9a2.5 2.5 0 11-1.5-2.3V4l-6 1.2v6.3a2.5 2.5 0 11-1.5-2.3V3.5L13 2z", stroke: "currentColor", "stroke-width": 1.1, fill: "none", "stroke-linejoin": "round" })],
  heart: () => [h("path", { d: "M8 14s-5-3.5-5-7.5C3 4 5 3 6.5 3 7.5 3 8 4 8 4s.5-1 1.5-1C11 3 13 4 13 6.5c0 4-5 7.5-5 7.5z", stroke: "currentColor", "stroke-width": 1.2, fill: "none", "stroke-linejoin": "round" })],
  star: () => [h("path", { d: "M8 1.8l1.7 3.7 4.1.5-3 2.9.8 4-3.6-2-3.6 2 .8-4-3-2.9 4.1-.5L8 1.8z", stroke: "currentColor", "stroke-width": 1.1, fill: "none", "stroke-linejoin": "round" })],
  note: () => [h("path", { d: "M5 12.5a1.5 1.5 0 11-1.5-1.5v-7l8-2v5.5a1.5 1.5 0 11-1.5-1.5v-3.5l-5 1.3v6.2z", stroke: "currentColor", "stroke-width": 1.1, fill: "none", "stroke-linejoin": "round" })],
  folder: () => [h("path", { d: "M1.5 4.5h4l1.5 1.5h7.5v8h-13v-9.5z", stroke: "currentColor", "stroke-width": 1.2, fill: "none", "stroke-linejoin": "round" })],
  edit: () => [h("path", { d: "M2 14l3-1 8.5-8.5-2-2L3 11l-1 3z", stroke: "currentColor", "stroke-width": 1.2, fill: "none", "stroke-linejoin": "round" })],
  refresh: () => [h("path", { d: "M14 8a6 6 0 11-1.5-4M14 3v3.5h-3.5", stroke: "currentColor", "stroke-width": 1.3, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" })],
  up: () => [h("path", { d: "M8 12V4M4 8l4-4 4 4", stroke: "currentColor", "stroke-width": 1.2, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" })],
  down: () => [h("path", { d: "M8 4v8M4 8l4 4 4-4", stroke: "currentColor", "stroke-width": 1.2, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" })],
  dot: () => [h("circle", { cx: 8, cy: 8, r: 2, fill: "currentColor" })],
  gear: () => [
    h("circle", { cx: 8, cy: 8, r: 2, stroke: "currentColor", "stroke-width": 1.1, fill: "none" }),
    h("path", { d: "M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3", stroke: "currentColor", "stroke-width": 1.1, "stroke-linecap": "round" }),
  ],
};

const inner = computed(() => (ICONS[props.name] ?? ICONS.dot)());
</script>

<template>
  <svg
    class="es-icon"
    :class="`es-icon-${name}`"
    :width="sizeStr"
    :height="sizeStr"
    viewBox="0 0 16 16"
    :role="label ? 'img' : 'presentation'"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    xmlns="http://www.w3.org/2000/svg"
  ><component :is="() => inner" /></svg>
</template>

<style scoped>
.es-icon { display: inline-block; vertical-align: middle; flex-shrink: 0; }
</style>