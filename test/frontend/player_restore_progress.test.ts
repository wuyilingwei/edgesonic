import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/stores/player.ts"), "utf-8");
const restoredQueue = source.indexOf("queue.value = saved;");
const restoredIndex = source.indexOf("index.value = savedIdx;", restoredQueue);
const restoredDuration = source.indexOf("duration.value = saved[savedIdx].duration || 0;", restoredIndex);
const restoredTime = source.indexOf("currentTime.value = rawTime", restoredDuration);

const passed = restoredQueue >= 0 && restoredIndex > restoredQueue && restoredDuration > restoredIndex && restoredTime > restoredDuration;
if (passed) console.log("  ✓ restored queue initializes duration before showing saved progress");
else {
  console.error("  ✗ restored queue must initialize duration before saved progress");
  process.exit(1);
}
