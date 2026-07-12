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
