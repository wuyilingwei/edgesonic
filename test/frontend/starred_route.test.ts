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

// Contract checks for the standalone liked-library route.
// Run: npx tsx test/frontend/starred_route.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const root = join(__dirname, "..", "..");
const app = readFileSync(join(root, "web", "src", "App.vue"), "utf8");
const main = readFileSync(join(root, "web", "src", "main.ts"), "utf8");
const library = readFileSync(join(root, "web", "src", "views", "Library.vue"), "utf8");

console.log("standalone liked route:");
assert(/path:\s*"\/starred"[\s\S]*?props:\s*\{\s*starredOnly:\s*true\s*\}/.test(main), "route mounts Library in starred-only mode");
assert(/path:\s*"\/starred"/.test(app), "navigation includes the starred path");
assert(/app\.menu\.starred/.test(app), "navigation uses a dedicated starred label");
assert(/defineProps<\{\s*starredOnly\?: boolean\s*\}>/.test(library), "Library accepts starredOnly");
assert(/v-if="!starredOnly" class="library-search"/.test(library), "standalone page hides the library search");
assert(/v-if="!currentArtist && !currentAlbum" class="library-controls"/.test(library), "standalone page shows shared library controls");
assert(/@click="switchTab\('artists'\)"/.test(library) && /@click="switchTab\('albums'\)"/.test(library) && /@click="switchTab\('songs'\)"/.test(library), "standalone page exposes all three tabs");
assert(!/tab === 'starred'/.test(library), "standalone page has no combined starred tab");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
