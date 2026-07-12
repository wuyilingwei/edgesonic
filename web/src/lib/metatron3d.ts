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

// Real-3D renderer for the Stardust "Metatron" solid: two regular
// tetrahedra interlocked at 180° (a stella octangula), drawn fully solid
// with per-face lighting. Repeated CSS attempts (clip-path facet fans,
// preserve-3d face rigs) flatten back to a plane because filter/clip-path
// on the same element forces a 3D flattening group, so the solid is
// rasterised here per frame instead: rotate → cull → depth-sort → shade.
//
// The two tetrahedra interpenetrate, so painter's sorting over their 8 big
// faces produces artefacts along the intersection. The visible surface is
// therefore expanded into the 24 outward spike triangles (one spike per
// cube corner over the shared central octahedron, three lateral faces
// each); those never cross, so backface culling + centroid depth sort is
// exact. See test/frontend/metatron_geometry.test.ts for the invariants.

export type Vec3 = [number, number, number];

export interface MetatronTri {
  v: [Vec3, Vec3, Vec3];
  /** 0 = tetrahedron with positive-parity corners, 1 = its 180° twin. */
  tetra: 0 | 1;
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// Apex corners (±1,±1,±1)/√3 sit on the unit sphere; the central octahedron
// vertices (±1,0,0)/√3, (0,±1,0)/√3, (0,0,±1)/√3 are where the twin
// tetrahedra's edges cross.
const CORNER = 1 / Math.sqrt(3);

export function buildStarTetrahedron(): MetatronTri[] {
  const tris: MetatronTri[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const tetra: 0 | 1 = sx * sy * sz > 0 ? 0 : 1;
        const apex: Vec3 = [sx * CORNER, sy * CORNER, sz * CORNER];
        const bx: Vec3 = [sx * CORNER, 0, 0];
        const by: Vec3 = [0, sy * CORNER, 0];
        const bz: Vec3 = [0, 0, sz * CORNER];
        for (const [b, c] of [[bx, by], [by, bz], [bz, bx]] as Array<[Vec3, Vec3]>) {
          const n = cross(sub(b, apex), sub(c, apex));
          const centroid: Vec3 = [
            (apex[0] + b[0] + c[0]) / 3,
            (apex[1] + b[1] + c[1]) / 3,
            (apex[2] + b[2] + c[2]) / 3,
          ];
          // The solid is star-shaped around the origin, so "outward" is
          // simply "away from the centre"; flip the winding when needed.
          tris.push(dot(n, centroid) >= 0 ? { v: [apex, b, c], tetra } : { v: [apex, c, b], tetra });
        }
      }
    }
  }
  return tris;
}

/** Ry→Rx→Rz tumble rotation, returned as a per-vertex mapper. */
export function makeRotation(ax: number, ay: number, az: number): (v: Vec3) => Vec3 {
  const sx = Math.sin(ax), cx = Math.cos(ax);
  const sy = Math.sin(ay), cy = Math.cos(ay);
  const sz = Math.sin(az), cz = Math.cos(az);
  return ([x0, y0, z0]: Vec3): Vec3 => {
    const x1 = x0 * cy + z0 * sy;
    const z1 = -x0 * sy + z0 * cy;
    const y2 = y0 * cx - z1 * sx;
    const z2 = y0 * sx + z1 * cx;
    return [x1 * cz - y2 * sz, x1 * sz + y2 * cz, z2];
  };
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const full = h.length === 3 ? `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : h;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function clampChannel(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x)));
}

// Fixed key light from the upper left front. Earlier revisions hue-shifted
// shadowed faces toward cobalt (first as a flat additive haze, then as a
// proportional mix) — either way that puts a second colour on the solid.
// Rosmontis wants the gold hue held constant everywhere: only its
// *vividness* — brightness and saturation together — should move with the
// angle to the light, so facets read as a faceted gold gem rather than
// shading into blue.
const LIGHT = normalize([-0.5, 0.78, 0.62]);
const HALF = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

function shadeFace(base: Rgb, n: Vec3): string {
  const lam = Math.max(0, dot(n, LIGHT));
  const spec = Math.pow(Math.max(0, dot(n, HALF)), 24) * 1.15;
  // Desaturate toward this face's own gray (same luminance, zero chroma) in
  // shadow, and hold full chroma when lit — a hue-preserving vividness
  // slider, not a mix toward a different base colour.
  const gray = (base[0] + base[1] + base[2]) / 3;
  const sat = 0.45 + 0.55 * lam;
  const lit = 0.36 + 0.86 * lam;
  const r = clampChannel((gray + (base[0] - gray) * sat) * lit + 255 * spec);
  const g = clampChannel((gray + (base[1] - gray) * sat) * lit + 255 * spec);
  const b = clampChannel((gray + (base[2] - gray) * sat) * lit + 255 * spec);
  return `rgb(${r},${g},${b})`;
}

export interface MetatronOptions {
  /** CSS pixel box (the canvas is square); falls back to layout width, then 24. */
  size?: number;
  /** Seconds for one full revolution around the vertical axis. */
  spinSeconds?: number;
  /** 0..1 offset into the tumble cycle so instances don't sync up. */
  phase?: number;
  /** Base fill for both tetrahedra (Stardust gold). Facets read as one gold
   * hue throughout — see shadeFace — so there's no separate twin colour. */
  color?: string;
}

const TRIS = buildStarTetrahedron();
// Mild perspective; at PERSP=3.4 the nearest vertex magnifies ×1.42, which
// the 0.68 projection scale keeps inside the canvas box.
const PERSP = 3.4;

/**
 * Starts the tumbling render loop on `canvas` and returns a stop function.
 * Under prefers-reduced-motion a single lit frame is drawn instead.
 */
export function startMetatron(canvas: HTMLCanvasElement, opts: MetatronOptions = {}): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const size = opts.size && opts.size > 0 ? opts.size : canvas.clientWidth || 24;
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  canvas.width = Math.max(2, Math.round(size * dpr));
  canvas.height = canvas.width;

  const spinMs = (opts.spinSeconds ?? 16) * 1000;
  const phase = opts.phase ?? 0;
  const gold = hexToRgb(opts.color ?? "#ffd64a");
  const half = size / 2;
  const scale = half * 0.68;

  const project = (v: Vec3): [number, number] => {
    const s = PERSP / (PERSP - v[2]);
    return [half + v[0] * s * scale, half - v[1] * s * scale];
  };

  interface Face {
    p: [[number, number], [number, number], [number, number]];
    fill: string;
    z: number;
  }

  const drawFrame = (nowMs: number) => {
    const t = (nowMs / spinMs + phase) * Math.PI * 2;
    const rotate = makeRotation(t * 0.83 + 0.35, t, t * 0.47);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const faces: Face[] = [];
    for (const tri of TRIS) {
      const [a0, b0, c0] = tri.v;
      const a = rotate(a0);
      const b = rotate(b0);
      const c = rotate(c0);
      const n = normalize(cross(sub(b, a), sub(c, a)));
      if (n[2] <= 0.001) continue; // backface: turned away from the +z viewer
      faces.push({
        z: (a[2] + b[2] + c[2]) / 3,
        fill: shadeFace(gold, n),
        p: [project(a), project(b), project(c)],
      });
    }
    faces.sort((f, g) => f.z - g.z); // painter's order: far → near

    for (const f of faces) {
      ctx.beginPath();
      ctx.moveTo(f.p[0][0], f.p[0][1]);
      ctx.lineTo(f.p[1][0], f.p[1][1]);
      ctx.lineTo(f.p[2][0], f.p[2][1]);
      ctx.closePath();
      ctx.fillStyle = f.fill;
      // Same-colour hairline stroke closes antialiasing seams between faces.
      ctx.strokeStyle = f.fill;
      ctx.lineJoin = "round";
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    }
  };

  const media = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  if (media?.matches) {
    drawFrame(spinMs * 0.18); // one static, still lit and angled, frame
    return () => {};
  }

  let raf = requestAnimationFrame(function loop(now) {
    drawFrame(now);
    raf = requestAnimationFrame(loop);
  });
  return () => cancelAnimationFrame(raf);
}
