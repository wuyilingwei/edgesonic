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

// Run: npx tsx test/frontend/track_match_separators.test.ts

import { normalizeForMatch } from "../../web/src/lib/trackMatch";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const expected = "jay'ed ms.ooja";

console.log("normalizeForMatch metadata separators:");
for (const sep of [",", "，", "/", ";", "；"]) {
  assert(normalizeForMatch(`JAY'ED ${sep} Ms.OOJA`) === expected, `separator ${sep} normalizes`);
}
assert(normalizeForMatch("01 - JAY'ED / Ms.OOJA") === expected, "track prefix + separator normalizes");

if (failures) process.exit(1);
