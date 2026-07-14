import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "web/src/App.vue"), "utf-8");
const player = fs.readFileSync(path.join(root, "web/src/components/PlayerBar.vue"), "utf-8");
const nowPlaying = fs.readFileSync(path.join(root, "web/src/views/NowPlaying.vue"), "utf-8");

const checks: [string, boolean][] = [
  ["the mobile logo always opens navigation", app.includes("openMenuFromLogo") && app.includes("menuOpen.value = true")],
  ["the standalone hamburger is removed", !app.includes('class="hamburger"')],
  ["the collapsed player hides controls", player.includes(".player-bar:not(.details-open) .pb-center")],
  ["the detail player hides track metadata", player.includes(".player-bar.details-open .pb-track")],
  ["track swipes advance or go back", player.includes("@touchstart=\"onTrackTouchStart\"") && player.includes("player.prev(true)")],
  ["collapsed mobile playback shows a square cover progress", player.includes("pb-cover-ring") && player.includes("<rect class=\"pb-cover-ring-fill\"")],
  ["expanded mobile playback restores the horizontal progress", player.includes(".player-bar.details-open .pb-progress-row")],
  ["the queue button remains available in both mobile states", player.includes(".player-bar:not(.details-open) .pb-right") && player.includes(".player-bar.details-open .pb-right")],
  ["only mobile details show a collapse button", app.includes('class="now-playing-collapse"') && app.includes("display: none") && app.includes("@media (max-width: 960px)")],
  ["the progress bar supports touch dragging", player.includes("@pointerdown=\"onProgressPointerDown\"") && player.includes("pointermove")],
  ["the detail shell locks page scrolling", app.includes(".now-playing-shell .main") && app.includes("overflow: hidden")],
  ["lyrics return to automatic centering", nowPlaying.includes("lyricsReturnTimer") && nowPlaying.includes("centerActiveLyric")],
  ["lyrics remain the scroll container", nowPlaying.includes(".np-right") && nowPlaying.includes("overflow-y: auto")],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}`); }
}

if (failures > 0) process.exit(1);
