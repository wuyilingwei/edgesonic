import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const library = fs.readFileSync(path.join(root, "web/src/views/Library.vue"), "utf-8");
const rowMenu = fs.readFileSync(path.join(root, "web/src/components/SongRowMenu.vue"), "utf-8");

const checks: [string, boolean][] = [
  ["mobile song tables hide their headers", library.includes(".song-table .table-header { display: none; }")],
  ["mobile song rows use two visual lines", library.includes('"title time menu"') && library.includes('"artist artist menu"')],
  ["mobile song metadata includes the album", library.includes(':data-album="s.album"') && library.includes('content: " - " attr(data-album)')],
  ["mobile hides standalone like buttons", library.includes(".song-table .row-like-btn { display: none; }")],
  ["mobile menus offer like actions", rowMenu.includes("row-menu-like") && rowMenu.includes("toggleStar")],
  ["mobile album grids adapt between two and three columns", library.includes("Math.min(3, Math.max(2, count))") && library.includes("repeat(3, minmax(0, 1fr))")],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}`); }
}

if (failures > 0) process.exit(1);
