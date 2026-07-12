<script setup lang="ts">
// Stardust theme background: solid dual-tetrahedron Metatron forms drift
// across every page, plus a click-anywhere cube-drop flourish. This
// component is registered as `background` in ./index.ts and is only ever
// mounted while the Stardust theme is active — its own onMounted/
// onBeforeUnmount lifecycle *is* the activation signal, so unlike the
// version this was extracted from (App.vue, pre-registry) there's no
// `watch(isStardust, ...)` here: the component simply doesn't exist while
// another theme is active.
import { ref, onMounted, onBeforeUnmount } from "vue";
import { startMetatron } from "../../lib/metatron3d";

// CSS keeps the cheap left-to-right drift; the tumbling solid itself is a
// real 3D render (rotate/cull/sort/light per frame) on a small canvas per
// form, because filter/clip-path on the same element flattens CSS
// preserve-3d.
//
// A fixed number of "slots" each independently schedule their own
// crossing — random height, size and speed, plus a vertical wobble so the
// path isn't a straight horizontal line. Before a slot starts a new
// crossing it samples the candidate's full (x, y) path against every other
// currently-active slot's path at the same instants; if any pair of
// samples lands within the sum of the two forms' half-sizes plus a small
// visual safety margin, it re-rolls, optionally
// retrying a bounded number of times before accepting anyway so a slot is
// never starved indefinitely (visible count never collapses).
const METATRON_SLOTS = 8;
const HEIGHT_MIN_VH = 4;
const HEIGHT_MAX_VH = 88;
const WOBBLE_MAX_VH = 18; // vertical drift over one crossing, off a straight line
const SIZE_MIN = 96;
const SIZE_MAX = 224;
const DURATION_MIN_S = 30;
const DURATION_MAX_S = 64;
const COLLISION_SAMPLES = 12; // samples across the time-overlap segment
const COLLISION_PADDING_PX = 48; // extra breathing room beyond actual overlap
const COLLISION_RETRY_CAP = 6; // more re-rolls now that fewer slots compete
const COLLISION_RETRY_DELAY_MS = 220; // small backoff so re-rolls spread across frames

interface DriftMetatron {
  key: number;
  top: number;       // vh, this crossing's base vertical position
  midOffset: number; // vh delta at 50% of the crossing (wobble)
  endOffset: number; // vh delta at 100% of the crossing (wobble)
  size: number;       // px
  durationS: number;
  spinSeconds: number;
  phase: number;
  opacity: number;
  startedAt: number;  // performance.now() ms — for collision time-window checks
}
type DriftCandidate = Omit<DriftMetatron, "key" | "startedAt">;

function randomDriftCandidate(): DriftCandidate {
  return {
    top: HEIGHT_MIN_VH + Math.random() * (HEIGHT_MAX_VH - HEIGHT_MIN_VH),
    midOffset: (Math.random() - 0.5) * 2 * WOBBLE_MAX_VH,
    endOffset: (Math.random() - 0.5) * 2 * WOBBLE_MAX_VH,
    size: Math.round(SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN)),
    durationS: DURATION_MIN_S + Math.random() * (DURATION_MAX_S - DURATION_MIN_S),
    spinSeconds: 18 + Math.random() * 22,
    phase: Math.random(),
    opacity: 0.18 + Math.random() * 0.18,
  };
}

// Path of a single crossing at time `tMs` ms since its own start, in
// viewport pixels. Mirrors the `metatronDrift` keyframes exactly:
//   x: -10vw -> 110vw linear in duration
//   y: 0 -> midOffset at 50% -> endOffset at 100% (two-segment polyline)
function driftPathAt(m: Pick<DriftCandidate, "top" | "midOffset" | "endOffset" | "size" | "durationS">, tMs: number): { x: number; y: number; half: number } {
  const frac = Math.max(0, Math.min(1, tMs / (m.durationS * 1000)));
  const xVw = -10 + frac * 120;
  let yVh: number;
  if (frac <= 0.5) {
    yVh = m.top + m.midOffset * (frac * 2);
  } else {
    yVh = m.top + m.midOffset + (m.endOffset - m.midOffset) * ((frac - 0.5) * 2);
  }
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 900;
  return { x: (xVw * vw) / 100, y: (yVh * vh) / 100, half: m.size / 2 };
}

// True iff the candidate would actually overlap another active slot on
// screen: samples both paths at COLLISION_SAMPLES+1 instants across their
// shared time-overlap window and checks pixel distance < sum of half-sizes
// plus COLLISION_PADDING_PX.
// Compared to the old full-wobble band×time test this only rejects true
// visual overlaps — wobble sweeps can cross as long as they're not at the
// same x at the same time.
function driftCollides(candidate: DriftCandidate, candidateStart: number, slots: (DriftMetatron | null)[], excludeSlot: number): boolean {
  const candDurMs = candidate.durationS * 1000;
  const candidateEnd = candidateStart + candDurMs;
  for (let idx = 0; idx < slots.length; idx++) {
    if (idx === excludeSlot) continue;
    const o = slots[idx];
    if (!o) continue;
    const otherEnd = o.startedAt + o.durationS * 1000;
    const overlapStart = Math.max(candidateStart, o.startedAt);
    const overlapEnd = Math.min(candidateEnd, otherEnd);
    if (overlapEnd <= overlapStart) continue;
    for (let s = 0; s <= COLLISION_SAMPLES; s++) {
      const tMs = overlapStart + ((overlapEnd - overlapStart) * s) / COLLISION_SAMPLES;
      const p1 = driftPathAt(candidate, tMs - candidateStart);
      const p2 = driftPathAt(o, tMs - o.startedAt);
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const minDist = p1.half + p2.half + COLLISION_PADDING_PX;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
  }
  return false;
}

const driftMetatrons = ref<(DriftMetatron | null)[]>(Array.from({ length: METATRON_SLOTS }, () => null));
let driftKeySeq = 0;
const driftTimers = new Map<number, number>();
const metatronStops = new Map<number, () => void>();

function scheduleDriftSlot(slot: number) {
  let attempts = 0;
  const attempt = () => {
    const now = performance.now();
    const candidate = randomDriftCandidate();
    if (driftCollides(candidate, now, driftMetatrons.value, slot)) {
      attempts++;
      if (attempts < COLLISION_RETRY_CAP) {
        driftTimers.set(slot, window.setTimeout(attempt, COLLISION_RETRY_DELAY_MS));
        return;
      }
      // Cap reached: accept anyway so the slot never starves and visible
      // count stays at METATRON_SLOTS instead of collapsing on rare busy frames.
    }
    driftMetatrons.value[slot] = { ...candidate, key: ++driftKeySeq, startedAt: now };
    driftTimers.set(slot, window.setTimeout(() => scheduleDriftSlot(slot), candidate.durationS * 1000));
  };
  attempt();
}
function stopDriftSystem() {
  driftTimers.forEach((t) => window.clearTimeout(t));
  driftTimers.clear();
}

function mountMetatron(el: unknown, key: number) {
  metatronStops.get(key)?.();
  metatronStops.delete(key);
  if (el instanceof HTMLCanvasElement) {
    const m = driftMetatrons.value.find((d) => d?.key === key);
    if (m) metatronStops.set(key, startMetatron(el, { size: m.size, spinSeconds: m.spinSeconds, phase: m.phase }));
  }
}

// Clicking anywhere on the page drops a tiny burst of falling Metatron
// solids from the click point. They use the same real-3D canvas renderer as
// the drifting background forms, only smaller and short-lived.
interface FallingMetatron { id: number; x: number; y: number; size: number; duration: string; delay: string; drift: string; spinSeconds: number; phase: number; }
let fallingMetatronSeq = 0;
const fallingMetatrons = ref<FallingMetatron[]>([]);
const fallingMetatronStops = new Map<number, () => void>();
function spawnFallingMetatrons(x: number, y: number) {
  const count = 1 + Math.floor(Math.random() * 3);
  for (let n = 0; n < count; n++) {
    const id = ++fallingMetatronSeq;
    const durationS = 1.1 + Math.random() * 0.6;
    const delayS = Math.random() * 0.14;
    fallingMetatrons.value.push({
      id,
      x: x + (Math.random() - 0.5) * 36,
      y,
      size: Math.round(24 + Math.random() * 14),
      duration: `${durationS.toFixed(2)}s`,
      delay: `${delayS.toFixed(2)}s`,
      drift: `${Math.round((Math.random() - 0.5) * 90)}px`,
      spinSeconds: 0.9 + Math.random() * 0.8,
      phase: Math.random(),
    });
    window.setTimeout(() => {
      fallingMetatronStops.get(id)?.();
      fallingMetatronStops.delete(id);
      fallingMetatrons.value = fallingMetatrons.value.filter((m) => m.id !== id);
    }, (durationS + delayS + 0.2) * 1000);
  }
}
function mountFallingMetatron(el: unknown, id: number) {
  fallingMetatronStops.get(id)?.();
  fallingMetatronStops.delete(id);
  if (el instanceof HTMLCanvasElement) {
    const m = fallingMetatrons.value.find((d) => d.id === id);
    if (m) fallingMetatronStops.set(id, startMetatron(el, { size: m.size, spinSeconds: m.spinSeconds, phase: m.phase }));
  }
}
function onPageClick(e: MouseEvent) {
  spawnFallingMetatrons(e.clientX, e.clientY);
}

onMounted(() => {
  for (let slot = 0; slot < METATRON_SLOTS; slot++) scheduleDriftSlot(slot);
  window.addEventListener("click", onPageClick);
});
onBeforeUnmount(() => {
  stopDriftSystem();
  metatronStops.forEach((stop) => stop());
  metatronStops.clear();
  fallingMetatronStops.forEach((stop) => stop());
  fallingMetatronStops.clear();
  window.removeEventListener("click", onPageClick);
});
</script>

<template>
  <div class="stardust-bg" aria-hidden="true">
    <template v-for="(m, i) in driftMetatrons" :key="m ? m.key : `empty-${i}`">
      <div
        v-if="m"
        class="metatron-drift"
        :style="{
          top: `${m.top}vh`,
          animationDuration: `${m.durationS}s`,
          opacity: m.opacity,
          '--drift-mid': `${m.midOffset}vh`,
          '--drift-end': `${m.endOffset}vh`,
        }"
      >
        <canvas
          class="metatron-solid"
          :style="{ width: `${m.size}px`, height: `${m.size}px` }"
          :ref="(el) => mountMetatron(el, m.key)"
        ></canvas>
      </div>
    </template>
  </div>

  <!-- Click anywhere on the page to drop a burst of small Metatron solids. -->
  <div class="metatron-fall-layer" aria-hidden="true">
    <div
      v-for="m in fallingMetatrons"
      :key="m.id"
      class="falling-metatron"
      :style="{
        left: `${m.x}px`,
        top: `${m.y}px`,
        width: `${m.size}px`,
        height: `${m.size}px`,
        animationDuration: m.duration,
        animationDelay: m.delay,
        '--fall-drift': m.drift,
      }"
    >
      <canvas class="falling-metatron-solid" :ref="(el) => mountFallingMetatron(el, m.id)"></canvas>
    </div>
  </div>
</template>

<!-- Unscoped: these classes are also the extension point stardust.css
     styles from outside this component (loaded lazily via loadStyles in
     ./index.ts, same mechanism an external theme module would use). -->
<style>
.stardust-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    linear-gradient(115deg, rgba(5,6,17,0.6), rgba(77,93,255,0.14), rgba(255,214,74,0.08)),
    radial-gradient(circle at 20% 25%, rgba(122,77,255,0.32), transparent 28rem),
    radial-gradient(circle at 80% 10%, rgba(28,123,255,0.32), transparent 24rem),
    radial-gradient(circle at 62% 86%, rgba(255,214,74,0.16), transparent 26rem),
    #050611;
}
.metatron-drift {
  position: absolute;
  left: 0;
  /* Each crossing is a freshly-mounted element (see :key="m.key" above)
   * with its own duration and --drift-mid/--drift-end wobble, so
   * "forwards" (not "infinite") is correct: the JS scheduler replaces this
   * slot with a new element once the crossing ends, rather than looping
   * the same path forever.
   */
  animation: metatronDrift linear forwards;
}
.metatron-solid {
  display: block;
  filter: drop-shadow(0 0 14px rgba(255, 214, 74, 0.6)) drop-shadow(0 0 24px rgba(22, 120, 255, 0.18));
}

/* Left-to-right crossing with a gentle vertical wobble (--drift-mid at the
 * midpoint, --drift-end at the far side) so the path isn't a straight
 * horizontal line; both are set per-instance from the collision-checked
 * random candidate above.
 */
@keyframes metatronDrift {
  0%   { transform: translate(-10vw, 0); }
  50%  { transform: translate(50vw, var(--drift-mid, 0)); }
  100% { transform: translate(110vw, var(--drift-end, 0)); }
}
@media (prefers-reduced-motion: reduce) {
  .stardust-bg { display: none; }
}

/* --- Click-anywhere Metatron burst ---
 * Page-level fixed overlay, above navbar/sidebar, so pieces are visible
 * falling from a click no matter where on the page it lands. Each piece is
 * the same canvas-rendered Metatron solid used by the background, positioned
 * in raw viewport pixels from the click event.
 */
.metatron-fall-layer {
  position: fixed;
  inset: 0;
  z-index: 250;
  overflow: visible;
  pointer-events: none;
}
.falling-metatron {
  position: absolute;
  animation: metatronFall linear forwards;
  animation-duration: inherit;
}
.falling-metatron-solid {
  display: block;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 0 8px rgba(255, 214, 74, 0.62));
}
@keyframes metatronFall {
  0%   { transform: translate(0, 0); opacity: 1; }
  80%  { opacity: 1; }
  100% { transform: translate(var(--fall-drift), 190px); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .falling-metatron { animation: none; }
}
</style>
