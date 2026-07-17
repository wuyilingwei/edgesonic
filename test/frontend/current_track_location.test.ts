import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const root = path.resolve(__dirname, "../..");
const library = fs.readFileSync(path.join(root, "web/src/views/Library.vue"), "utf8");
const playerBar = fs.readFileSync(path.join(root, "web/src/components/PlayerBar.vue"), "utf8");

assert(playerBar.includes("revealCurrentQueueItem"), "opening the queue reveals the current track");
assert(playerBar.includes('scrollIntoView({ block: "center" })'), "queue centers the current track");
assert(library.includes("function locateCurrentSong()"), "library exposes manual current-track location");
assert(library.includes('showInfo(t("library.locateLoadMore"))'), "first unloaded lookup explains the second-click search");
assert(library.includes("while (!songsDone.value"), "second lookup scans remaining song pages");
assert(library.includes(':data-song-id="s.id"'), "song rows expose stable location anchors");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
