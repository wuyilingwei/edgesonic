// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseArtistCredits } from "../../worker/src/utils/artistCredits";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  PASS ${message}`);
  else { failures++; console.error(`  FAIL ${message}`); }
}

console.log("artist credit parsing:");
for (const separator of [",", "，", ";", "；", "/"]) {
  const credits = parseArtistCredits(`星尘${separator} 海伊`);
  assert(credits.map((credit) => credit.name).join("|") === "星尘|海伊", `${separator} splits two artists`);
}
assert(parseArtistCredits("Simon & Garfunkel").length === 1, "ampersand remains part of a group name");
assert(parseArtistCredits("星尘, 星尘").length === 1, "duplicate credits are removed");

process.exit(failures ? 1 : 0);
