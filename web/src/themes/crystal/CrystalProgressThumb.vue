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
// SP progress marker. Renders the active element's solid tumbling in a tiny
// WebGL canvas via the SAME Renderer the background drift and click-drop use —
// not CSS 3D, which collapses under filter/clip/stacking on the player bar.
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
