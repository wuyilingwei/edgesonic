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

// 134 — Stardust Metatron solid geometry (web/src/lib/metatron3d.ts).
//
// The Stardust background / progress-thumb "Metatron" is a stella
// octangula: two regular tetrahedra interlocked at 180°. The canvas
// renderer draws it as the 24 outward spike triangles over the central
// octahedron and relies on these invariants for exact painter's rendering
// (no interpenetrating faces): outward-oriented windings, a closed
// 2-manifold surface, and a rigid (radius-preserving) rotation mapper.
//
// metatron3d.ts has no DOM access at module top level (startMetatron only
// touches window/canvas when called), so it imports fine under plain Node.
//
// Run: npx tsx test/frontend/metatron_geometry.test.ts

import { buildStarTetrahedron, makeRotation, cross, sub, dot } from "../../web/src/lib/metatron3d";
import type { Vec3 } from "../../web/src/lib/metatron3d";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const tris = buildStarTetrahedron();
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const OCTA = 1 / Math.sqrt(3);

console.log("stella octangula surface");
assert(tris.length === 24, "24 visible spike triangles");
assert(tris.filter((t) => t.tetra === 0).length === 12, "12 faces on the upright tetrahedron");
assert(tris.filter((t) => t.tetra === 1).length === 12, "12 faces on the inverted twin");

let outward = true;
let radiiOk = true;
for (const t of tris) {
  const [a, b, c] = t.v;
  const n = cross(sub(b, a), sub(c, a));
  const centroid: Vec3 = [
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
  ];
  if (dot(n, centroid) <= 1e-12) outward = false;
  // Each face joins one unit-sphere apex to two octahedron vertices.
  const radii = [len(a), len(b), len(c)].sort((x, y) => x - y);
  if (
    Math.abs(radii[2] - 1) > 1e-9 ||
    Math.abs(radii[1] - OCTA) > 1e-9 ||
    Math.abs(radii[0] - OCTA) > 1e-9
  ) radiiOk = false;
}
assert(outward, "every face winds outward (normal · centroid > 0)");
assert(radiiOk, "each face = 1 unit-sphere apex + 2 octahedron vertices");

const apexes = new Set(tris.map((t) => t.v[0].map((x) => Math.sign(x)).join(",")));
assert(apexes.size === 8, "spikes cover all 8 cube corners");

// Closed 2-manifold: with consistent outward winding every directed edge
// appears exactly once and its reversed twin exists (spike laterals share
// apex edges; neighbouring spikes share octahedron edges).
const key = (v: Vec3) => v.map((x) => x.toFixed(9)).join("|");
const directed = new Map<string, number>();
for (const t of tris) {
  const [a, b, c] = t.v;
  for (const [p, q] of [[a, b], [b, c], [c, a]] as Array<[Vec3, Vec3]>) {
    const k = `${key(p)}->${key(q)}`;
    directed.set(k, (directed.get(k) ?? 0) + 1);
  }
}
let manifold = directed.size === 72;
for (const [k, count] of directed) {
  const [from, to] = k.split("->");
  if (count !== 1 || directed.get(`${to}->${from}`) !== 1) manifold = false;
}
assert(manifold, "closed surface: each directed edge once, reversed twin present");

console.log("rotation mapper");
const rot = makeRotation(0.7, 1.3, 2.1);
let rigid = true;
for (const t of tris) {
  for (const v of t.v) {
    if (Math.abs(len(rot(v)) - len(v)) > 1e-9) rigid = false;
  }
}
assert(rigid, "makeRotation preserves vertex radii (rigid rotation)");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("all good");
