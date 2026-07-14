// Source-level contracts for player dragging, full buffering, and fallback.
// Run: npx tsx test/frontend/player_resilience.test.ts

import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const root = path.resolve(__dirname, "../..");
const playerSrc = fs.readFileSync(path.join(root, "web/src/stores/player.ts"), "utf8");
const barSrc = fs.readFileSync(path.join(root, "web/src/components/PlayerBar.vue"), "utf8");

const seekFunction = barSrc.match(/function seekFromEvent[\s\S]*?\n}\n/);
assert(seekFunction !== null, "progress-bar coordinate helper remains present");
assert(!seekFunction?.[0].includes("player.seek"), "mousemove coordinate updates do not seek the audio element");
assert(barSrc.includes("if (commit && target !== null) player.seek(target);"), "mouseup commits exactly one pending seek");
assert(barSrc.includes("onBeforeUnmount(() => stopProgressDrag(false));"), "drag listeners are cleaned up on unmount");

assert(playerSrc.includes('el.preload = "auto";'), "native audio keeps the full-load hint");
assert(playerSrc.includes("startFullDownload("), "current and next tracks consume complete responses");
assert(playerSrc.includes("fullyLoadedByElement"), "full Blob state is tracked separately from native buffered ranges");
assert(playerSrc.includes("next.push([0, dur]);"), "the buffer indicator covers the complete duration after full load");
assert(playerSrc.includes("preloaded && preloaded.index === index.value && preloaded.ready"), "next-track swap waits for the complete Blob");

assert(playerSrc.includes("FALLBACK_RANGE_STEPS"), "incremental Range fallback remains enabled");
assert(playerSrc.includes('state.phase = "full";'), "fallback advances from Range attempts to full-file attempts");
assert(playerSrc.includes("fallbackAfterMediaError"), "network, decode, and unsupported-source errors enter fallback");
assert(playerSrc.includes("advanceAfterFallbackFailure"), "exhausted fallback attempts have a terminal path");
assert(playerSrc.includes("console.error(\"[Player] all playback attempts failed, skipping track:\", reason);"), "terminal playback failure skips to the next track");
assert(!playerSrc.includes("fallbackAfterDemuxError"), "old demux-only error gate is removed");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
