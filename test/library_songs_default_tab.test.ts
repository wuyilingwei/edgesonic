// Task 076 — Library default tab.
//
// Verifies that Library.vue no longer reads localStorage to seed the active
// tab — every fresh mount must start on "songs" so users land on tracks even
// after they previously visited the albums grid.
//
// We don't boot the full Vue runtime here: the regression is small and
// localized to two source-level facts, so we grep the file for the offending
// pattern. Treating the source as the contract keeps the test cheap and
// avoids dragging in a DOM shim just to verify a one-line change.
//
// Run: npx tsx test/library_songs_default_tab.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const SRC = readFileSync(
  join(__dirname, "..", "web", "src", "views", "Library.vue"),
  "utf8",
);

console.log("Library.vue default tab:");
{
  // 1. tab ref must be hard-initialised to "songs" — no getItem branch.
  assert(
    /const\s+tab\s*=\s*ref<Tab>\(\s*"songs"\s*\)/.test(SRC),
    'tab ref defaults to "songs"',
  );

  // 2. No localStorage *reads* of the library_tab key — those are what made
  //    the default stick to whatever the user last clicked.
  assert(
    !/localStorage\.getItem\(\s*["']edgesonic_library_tab["']/.test(SRC),
    "no localStorage.getItem for library_tab",
  );

  // 3. No localStorage *writes* of the library_tab key — switchTab must not
  //    persist the choice. (Session-only switching is fine.)
  assert(
    !/localStorage\.setItem\(\s*["']edgesonic_library_tab["']/.test(SRC),
    "no localStorage.setItem for library_tab",
  );

  // 4. Sanity: switchTab still exists and toggles the ref.
  assert(/function\s+switchTab\s*\(\s*next:\s*Tab\s*\)/.test(SRC), "switchTab present");
  assert(/tab\.value\s*=\s*next/.test(SRC), "switchTab assigns ref");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
