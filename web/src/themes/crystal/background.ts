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

import { buildStarTetrahedron, sub, cross, type Vec3 } from "../../lib/metatron3d";

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
export type CrystalShape = "star" | "cube" | "octahedron" | "tetrahedron" | "icosahedron" | "dodecahedron";

function buildMesh(shape: CrystalShape): Float32Array {
  const tris = shape === "star" ? buildStarTetrahedron().map((tri) => tri.v) : primitiveTriangles(shape);
  const data: number[] = [];
  for (const tri of tris) {
    const [a, b, c] = tri;
    const raw = cross(sub(b, a), sub(c, a));
    const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const outward = raw[0] * centroid[0] + raw[1] * centroid[1] + raw[2] * centroid[2] >= 0;
    const vertices = outward ? [a, b, c] : [a, c, b];
    const n = normalize(outward ? raw : [-raw[0], -raw[1], -raw[2]]);
    for (const p of vertices) data.push(p[0], p[1], p[2], n[0], n[1], n[2]);
  }
  return new Float32Array(data);
}

// Max vertex distance from centre for a shape's mesh. The primitives aren't
// unit-normalised (a dodecahedron reaches ~0.52, a cube's corner ~1.0), so
// the thumb scales its `size` by 1/radius to show every element at the same
// on-screen extent.
function meshRadius(shape: CrystalShape): number {
  const m = buildMesh(shape);
  let max = 0;
  for (let i = 0; i < m.length; i += 6) {
    const r = Math.hypot(m[i], m[i + 1], m[i + 2]);
    if (r > max) max = r;
  }
  return max || 1;
}

function primitiveTriangles(shape: Exclude<CrystalShape, "star">): [Vec3, Vec3, Vec3][] {
  const s = 0.58;
  const cube: Vec3[] = [[-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s], [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]];
  if (shape === "cube") return [[cube[0], cube[1], cube[2]], [cube[0], cube[2], cube[3]], [cube[4], cube[6], cube[5]], [cube[4], cube[7], cube[6]], [cube[0], cube[4], cube[5]], [cube[0], cube[5], cube[1]], [cube[1], cube[5], cube[6]], [cube[1], cube[6], cube[2]], [cube[2], cube[6], cube[7]], [cube[2], cube[7], cube[3]], [cube[3], cube[7], cube[4]], [cube[3], cube[4], cube[0]]];
  if (shape === "tetrahedron") return [[[s, s, s], [s, -s, -s], [-s, s, -s]], [[s, s, s], [-s, s, -s], [-s, -s, s]], [[s, s, s], [-s, -s, s], [s, -s, -s]], [[s, -s, -s], [-s, -s, s], [-s, s, -s]]];
  if (shape === "icosahedron") {
    const p = 0.38, q = p * 1.618;
    const v: Vec3[] = [[-p,q,0],[p,q,0],[-p,-q,0],[p,-q,0],[0,-p,q],[0,p,q],[0,-p,-q],[0,p,-q],[q,0,-p],[q,0,p],[-q,0,-p],[-q,0,p]];
    const f = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
    return f.map(([a, b, c]) => [v[a], v[b], v[c]]);
  }
  if (shape === "dodecahedron") {
    const p = 0.3, q = p / 1.618, r = p * 1.618;
    const v: Vec3[] = [[-p,-p,-p],[-p,-p,p],[-p,p,-p],[-p,p,p],[p,-p,-p],[p,-p,p],[p,p,-p],[p,p,p],[0,-q,-r],[0,-q,r],[0,q,-r],[0,q,r],[-q,-r,0],[-q,r,0],[q,-r,0],[q,r,0],[-r,0,-q],[-r,0,q],[r,0,-q],[r,0,q]];
    const faces = [[0,8,10,2,16],[0,16,17,1,12],[0,12,14,4,8],[1,17,3,11,9],[1,9,5,14,12],[2,10,6,15,13],[2,13,3,17,16],[3,13,15,7,11],[4,14,5,19,18],[4,18,6,10,8],[5,9,11,7,19],[6,18,19,7,15]];
    return faces.flatMap(([a, b, c, d, e]) => [[v[a], v[b], v[c]], [v[a], v[c], v[d]], [v[a], v[d], v[e]]]);
  }
  const top: Vec3 = [0, s, 0], bottom: Vec3 = [0, -s, 0], east: Vec3 = [s, 0, 0], west: Vec3 = [-s, 0, 0], front: Vec3 = [0, 0, s], back: Vec3 = [0, 0, -s];
  return [[top, east, front], [top, front, west], [top, west, back], [top, back, east], [bottom, front, east], [bottom, west, front], [bottom, back, west], [bottom, east, back]];
}


const SOLID_VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform vec2 uCenter;   // px
uniform float uSize;    // px
uniform float uT;       // tumble parameter
uniform vec2 uViewport; // px
varying vec3 vNormal;
const float PERSP = 3.4;
vec3 tumble(vec3 p, float t) {
  float ax = t * 0.83 + 0.35, ay = t, az = t * 0.47;
  float sx = sin(ax), cx = cos(ax), sy = sin(ay), cy = cos(ay), sz = sin(az), cz = cos(az);
  float x1 = p.x * cy + p.z * sy;
  float z1 = -p.x * sy + p.z * cy;
  float y2 = p.y * cx - z1 * sx;
  float z2 = p.y * sx + z1 * cx;
  return vec3(x1 * cz - y2 * sz, x1 * sz + y2 * cz, z2);
}
void main() {
  vec3 rp = tumble(aPos, uT);
  vNormal = tumble(aNormal, uT);
  float s = PERSP / (PERSP - rp.z);
  vec2 posPx = uCenter + vec2(rp.x, -rp.y) * (s * uSize * 0.34);
  vec2 clip = (posPx / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, -rp.z, 1.0);
}`;

const SOLID_FS = `
precision mediump float;
varying vec3 vNormal;
uniform vec3 uGold;
uniform float uAlpha;
const vec3 LIGHT = vec3(-0.5, 0.78, 0.62);
void main() {
  vec3 n = normalize(vNormal);
  if (n.z <= 0.001) discard;
  vec3 L = normalize(LIGHT);
  vec3 H = normalize(vec3(L.x, L.y, L.z + 1.0));
  float lam = max(0.0, dot(n, L));
  float spec = pow(max(0.0, dot(n, H)), 24.0) * 1.15;
  float lit = 0.28 + 0.72 * lam;
  vec3 col = uGold * (lit + 0.12) + vec3(spec);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), uAlpha);
}`;

const GLOW_VS = `
attribute vec2 aQuad;
uniform vec2 uCenter;
uniform float uRadius;
uniform vec2 uViewport;
varying vec2 vUv;
void main() {
  vUv = aQuad;
  vec2 posPx = uCenter + aQuad * uRadius;
  vec2 clip = (posPx / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;
const GLOW_FS = `
precision mediump float;
varying vec2 vUv;
uniform vec3 uGold;
uniform vec3 uHalo;
uniform float uAlpha;
void main() {
  float d = length(vUv);
  float inner = exp(-d * d * 12.0);
  float middle = exp(-d * d * 4.5);
  float outer = exp(-d * d * 1.8);
  float a = (inner * 0.7 + middle * 0.24 + outer * 0.1) * uAlpha;
  vec3 col = uGold * (inner * 0.7 + middle * 0.24) + uHalo * (outer * 0.18);
  gl_FragColor = vec4(col * uAlpha, a);
}`;

export interface Instance { cx: number; cy: number; size: number; t: number; alpha: number; }

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { gl.deleteShader(sh); return null; }
  return sh;
}
function link(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram | null {
  const v = compile(gl, gl.VERTEX_SHADER, vs), f = compile(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { gl.deleteProgram(p); return null; }
  return p;
}

class Renderer {
  private gl: WebGLRenderingContext;
  private solid: WebGLProgram;
  private glow: WebGLProgram;
  private meshBuf: WebGLBuffer;
  private quadBuf: WebGLBuffer;
  private vertexCount: number;
  private dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  ok = false;

  constructor(private canvas: HTMLCanvasElement, private color: [number, number, number], private halo: [number, number, number], shape: CrystalShape, private glowAlpha = 0.72, private glowRadius = 1.35) {
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: true, depth: true });
    if (!gl) { this.gl = null as never; this.solid = null as never; this.glow = null as never; this.meshBuf = null as never; this.quadBuf = null as never; this.vertexCount = 0; return; }
    this.gl = gl;
    const solid = link(gl, SOLID_VS, SOLID_FS);
    const glow = link(gl, GLOW_VS, GLOW_FS);
    if (!solid || !glow) { this.solid = null as never; this.glow = null as never; this.meshBuf = null as never; this.quadBuf = null as never; this.vertexCount = 0; return; }
    this.solid = solid; this.glow = glow;
    const mesh = buildMesh(shape);
    this.vertexCount = mesh.length / 6;
    const mb = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, mb); gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    this.meshBuf = mb;
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const qb = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    this.quadBuf = qb;
    this.ok = true;
  }

  private resize(w: number, h: number) {
    const cw = Math.round(w * this.dpr), ch = Math.round(h * this.dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
  }

  render(instances: Instance[], w: number, h: number) {
    if (!this.ok) return;
    const gl = this.gl;
    this.resize(w, h);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    const vp: [number, number] = [w, h];

    gl.disable(gl.DEPTH_TEST);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.glow);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const aQuad = gl.getAttribLocation(this.glow, "aQuad");
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2fv(gl.getUniformLocation(this.glow, "uViewport"), vp);
    gl.uniform3fv(gl.getUniformLocation(this.glow, "uGold"), this.color);
    gl.uniform3fv(gl.getUniformLocation(this.glow, "uHalo"), this.halo);
    for (const it of instances) {
      gl.uniform2f(gl.getUniformLocation(this.glow, "uCenter"), it.cx, it.cy);
      gl.uniform1f(gl.getUniformLocation(this.glow, "uRadius"), it.size * this.glowRadius);
      gl.uniform1f(gl.getUniformLocation(this.glow, "uAlpha"), it.alpha * this.glowAlpha);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.solid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuf);
    const aPos = gl.getAttribLocation(this.solid, "aPos");
    const aNormal = gl.getAttribLocation(this.solid, "aNormal");
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(aNormal); gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 24, 12);
    gl.uniform2fv(gl.getUniformLocation(this.solid, "uViewport"), vp);
    gl.uniform3fv(gl.getUniformLocation(this.solid, "uGold"), this.color);
    const uCenter = gl.getUniformLocation(this.solid, "uCenter");
    const uSize = gl.getUniformLocation(this.solid, "uSize");
    const uT = gl.getUniformLocation(this.solid, "uT");
    const uAlpha = gl.getUniformLocation(this.solid, "uAlpha");
    for (const it of instances) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniform2f(uCenter, it.cx, it.cy);
      gl.uniform1f(uSize, it.size);
      gl.uniform1f(uT, it.t);
      gl.uniform1f(uAlpha, it.alpha);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    }
  }

  dispose() {
    if (!this.gl) return;
    const gl = this.gl;
    gl.deleteBuffer(this.meshBuf); gl.deleteBuffer(this.quadBuf);
    gl.deleteProgram(this.solid); gl.deleteProgram(this.glow);
    const ext = gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}

const METATRON_SLOTS = 4;
const HEIGHT_MIN_VH = 4, HEIGHT_MAX_VH = 88;
const WOBBLE_MAX_VH = 18;
const SIZE_MIN = 96, SIZE_MAX = 224;
const DURATION_MIN_S = 30, DURATION_MAX_S = 64;
const COLLISION_SAMPLES = 12;
const COLLISION_PADDING_PX = 96;
const COLLISION_RETRY_CAP = 8;
const COLLISION_RETRY_DELAY_MS = 220;
const INITIAL_STAGGER_BASE_MS = 900;
const INITIAL_STAGGER_JITTER_MS = 600;

interface Drift { key: number; top: number; midOffset: number; endOffset: number; size: number; durationS: number; spinSeconds: number; phase: number; opacity: number; startedAt: number; }
type DriftCandidate = Omit<Drift, "key" | "startedAt">;

function randomDrift(opacity: [number, number]): DriftCandidate {
  return {
    top: HEIGHT_MIN_VH + Math.random() * (HEIGHT_MAX_VH - HEIGHT_MIN_VH),
    midOffset: (Math.random() - 0.5) * 2 * WOBBLE_MAX_VH,
    endOffset: (Math.random() - 0.5) * 2 * WOBBLE_MAX_VH,
    size: Math.round(SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN)),
    durationS: DURATION_MIN_S + Math.random() * (DURATION_MAX_S - DURATION_MIN_S),
    spinSeconds: 18 + Math.random() * 22,
    phase: Math.random(),
    opacity: opacity[0] + Math.random() * (opacity[1] - opacity[0]),
  };
}
// Per-element drift direction so the themes don't all sweep left→right.
// Every mode traverses fully and exits, so a slot can re-roll offscreen
// without popping.
export type DriftMotion = "ltr" | "rtl" | "rise" | "fall" | "diagonal";

function driftPathAt(m: Pick<DriftCandidate, "top" | "midOffset" | "endOffset" | "size" | "durationS">, tMs: number, motion: DriftMotion = "ltr"): { x: number; y: number; half: number } {
  const frac = Math.max(0, Math.min(1, tMs / (m.durationS * 1000)));
  const wob = frac <= 0.5 ? m.midOffset * (frac * 2) : m.midOffset + (m.endOffset - m.midOffset) * ((frac - 0.5) * 2);
  let xVw: number, yVh: number;
  if (motion === "rise" || motion === "fall") {
    const p = motion === "rise" ? 1 - frac : frac; // 0(top)→1(bottom)
    yVh = -12 + p * 124;
    xVw = (m.top / 88) * 100 + wob; // spread columns across width + horizontal sway
  } else if (motion === "diagonal") {
    xVw = -10 + frac * 120;
    yVh = m.top + (frac - 0.5) * 36 + wob;
  } else if (motion === "rtl") {
    xVw = 110 - frac * 120;
    yVh = m.top + wob;
  } else {
    xVw = -10 + frac * 120;
    yVh = m.top + wob;
  }
  const vw = window.innerWidth || 1280, vh = window.innerHeight || 900;
  return { x: (xVw * vw) / 100, y: (yVh * vh) / 100, half: m.size / 2 };
}
function driftCollides(candidate: DriftCandidate, candidateStart: number, slots: (Drift | null)[], excludeSlot: number, motion: DriftMotion): boolean {
  const candEnd = candidateStart + candidate.durationS * 1000;
  for (let idx = 0; idx < slots.length; idx++) {
    if (idx === excludeSlot) continue;
    const o = slots[idx];
    if (!o) continue;
    const otherEnd = o.startedAt + o.durationS * 1000;
    const start = Math.max(candidateStart, o.startedAt);
    const end = Math.min(candEnd, otherEnd);
    if (end <= start) continue;
    for (let s = 0; s <= COLLISION_SAMPLES; s++) {
      const tMs = start + ((end - start) * s) / COLLISION_SAMPLES;
      const p1 = driftPathAt(candidate, tMs - candidateStart, motion);
      const p2 = driftPathAt(o, tMs - o.startedAt, motion);
      const dx = p1.x - p2.x, dy = p1.y - p2.y;
      const minDist = p1.half + p2.half + COLLISION_PADDING_PX;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
  }
  return false;
}

interface Falling { id: number; x: number; y: number; size: number; durationMs: number; delayMs: number; drift: number; spinSeconds: number; phase: number; startedAt: number; }

export interface CrystalBackgroundOptions {
  color: [number, number, number];
  halo: [number, number, number];
  shape: CrystalShape;
  opacity: [number, number];
  backgroundClass: string;
  fallClass: string;
  motion?: DriftMotion;
}

// A single solid tumbling in place on a tiny canvas — the player-bar progress
// marker. Uses the same WebGL Renderer as the drifting background crystals and
// the click-drop pieces. No glow pass — a CSS drop-shadow on the canvas
// supplies the halo without clipping to canvas bounds.
const THUMB_SIZE = 42 * 0.8;

export function mountCrystalThumb(host: HTMLElement, options: { color: [number, number, number]; halo: [number, number, number]; shape: CrystalShape }): () => void {
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.createElement("canvas");
  canvas.className = "crystal-thumb-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);
  const remove = () => canvas.remove();

  const renderer = new Renderer(canvas, options.color, options.halo, options.shape, 0, 1);
  if (!renderer.ok) { renderer.dispose(); return remove; }

  const CSS = 44; // canvas viewport, CSS px
  const size = THUMB_SIZE / meshRadius(options.shape); // same on-screen extent for every shape
  if (reduce) {
    renderer.render([{ cx: CSS / 2, cy: CSS / 2, size, t: 0.9, alpha: 1 }], CSS, CSS);
    return () => { renderer.dispose(); remove(); };
  }
  let raf = 0;
  const frame = () => {
    const now = performance.now();
    renderer.render([{ cx: CSS / 2, cy: CSS / 2, size, t: now / 800, alpha: 1 }], CSS, CSS);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); renderer.dispose(); remove(); };
}

export function mountCrystalBackground(host: HTMLElement, options: CrystalBackgroundOptions): () => void {
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const bg = document.createElement("div");
  bg.className = options.backgroundClass;
  bg.setAttribute("aria-hidden", "true");
  const bgCanvas = document.createElement("canvas");
  bgCanvas.className = "crystal-canvas";
  bg.appendChild(bgCanvas);
  host.appendChild(bg);

  const fxLayer = document.createElement("div");
  fxLayer.className = options.fallClass;
  fxLayer.setAttribute("aria-hidden", "true");
  const fxCanvas = document.createElement("canvas");
  fxCanvas.className = "crystal-canvas";
  fxLayer.appendChild(fxCanvas);
  document.body.appendChild(fxLayer);

  const cleanupDom = () => { bg.remove(); fxLayer.remove(); };
  if (reduce) return cleanupDom; // CSS also hides the bg layer; nothing animates

  const bgRenderer = new Renderer(bgCanvas, options.color, options.halo, options.shape);
  // Falling click-burst pieces are small and short-lived; the drift-layer's
  // full glow blooms too hard on them, so the fx renderer gets a dimmer,
  // tighter halo.
  const fxRenderer = new Renderer(fxCanvas, options.color, options.halo, options.shape, 0.3, 0.85);
  if (!bgRenderer.ok) return () => { bgRenderer.dispose(); fxRenderer.dispose(); cleanupDom(); };

  const slots: (Drift | null)[] = Array.from({ length: METATRON_SLOTS }, () => null);
  let keySeq = 0;
  const timers: number[] = [];

  function scheduleSlot(slot: number) {
    let attempts = 0;
    const attempt = () => {
      const now = performance.now();
      const candidate = randomDrift(options.opacity);
      if (driftCollides(candidate, now, slots, slot, options.motion ?? "ltr") && ++attempts < COLLISION_RETRY_CAP) {
        timers.push(window.setTimeout(attempt, COLLISION_RETRY_DELAY_MS));
        return;
      }
      slots[slot] = { ...candidate, key: ++keySeq, startedAt: now };
      timers.push(window.setTimeout(() => scheduleSlot(slot), candidate.durationS * 1000));
    };
    attempt();
  }
  for (let slot = 0; slot < METATRON_SLOTS; slot++) {
    timers.push(window.setTimeout(() => scheduleSlot(slot), slot * INITIAL_STAGGER_BASE_MS + Math.random() * INITIAL_STAGGER_JITTER_MS));
  }

  const falling: Falling[] = [];
  let fallSeq = 0;
  function onClick(e: MouseEvent) {
    for (let n = 0; n < 1; n++) {
      falling.push({
        id: ++fallSeq,
        x: e.clientX + (Math.random() - 0.5) * 36,
        y: e.clientY,
        size: Math.round(24 + Math.random() * 14),
        durationMs: (1.1 + Math.random() * 0.6) * 1000,
        delayMs: Math.random() * 140,
        drift: Math.round((Math.random() - 0.5) * 90),
        spinSeconds: 0.9 + Math.random() * 0.8,
        phase: Math.random(),
        startedAt: performance.now(),
      });
    }
  }
  window.addEventListener("click", onClick);

  let raf = 0;
  const frame = () => {
    const now = performance.now();
    const w = window.innerWidth, h = window.innerHeight;

    const driftInstances: Instance[] = [];
    for (const m of slots) {
      if (!m) continue;
      const p = driftPathAt(m, now - m.startedAt, options.motion ?? "ltr");
      driftInstances.push({ cx: p.x, cy: p.y, size: m.size, t: (now / (m.spinSeconds * 1000) + m.phase) * Math.PI * 2, alpha: m.opacity });
    }
    bgRenderer.render(driftInstances, w, h);

    const fxInstances: Instance[] = [];
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i];
      const prog = (now - f.startedAt - f.delayMs) / f.durationMs;
      if (prog >= 1) { falling.splice(i, 1); continue; }
      const p = Math.max(0, prog);
      const alpha = p < 0.8 ? 1 : Math.max(0, 1 - (p - 0.8) / 0.2);
      fxInstances.push({ cx: f.x + f.drift * p, cy: f.y + 190 * p, size: f.size, t: (now / (f.spinSeconds * 1000) + f.phase) * Math.PI * 2, alpha });
    }
    fxRenderer.render(fxInstances, w, h);

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    timers.forEach((t) => window.clearTimeout(t));
    window.removeEventListener("click", onClick);
    bgRenderer.dispose();
    fxRenderer.dispose();
    cleanupDom();
  };
}
