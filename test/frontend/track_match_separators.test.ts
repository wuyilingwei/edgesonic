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
