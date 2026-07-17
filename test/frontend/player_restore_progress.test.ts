import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/stores/player.ts"), "utf-8");
const restoredQueue = source.indexOf("queue.value = saved;");
const restoredIndex = source.indexOf("index.value = savedIdx;", restoredQueue);
const restoredDuration = source.indexOf("duration.value = saved[savedIdx].duration || 0;", restoredIndex);
const restoredTime = source.indexOf("currentTime.value = rawTime", restoredDuration);
const restoredPlaying = source.indexOf('_resumePlayback = playbackStorage.getItem("edgesonic:playing") === "1";', restoredTime);
const savedPlaying = source.indexOf('playbackStorage.setItem("edgesonic:playing", isPlaying ? "1" : "0")');
const resume = source.indexOf("function resumePlaybackIfNeeded()");
const pagehide = source.indexOf('window.addEventListener("pagehide"');
const unloadGuard = source.indexOf("if (_isUnloading) return;", pagehide);

const passed = restoredQueue >= 0 && restoredIndex > restoredQueue && restoredDuration > restoredIndex && restoredTime > restoredDuration && restoredPlaying > restoredTime && savedPlaying >= 0 && resume > savedPlaying && pagehide >= 0 && unloadGuard > pagehide;
if (passed) console.log("  ✓ restored queue preserves playback through page unload");
else {
  console.error("  ✗ restored queue must persist and restore playback state after progress");
  process.exit(1);
}
