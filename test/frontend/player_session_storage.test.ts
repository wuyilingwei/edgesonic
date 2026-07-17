import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/stores/player.ts"), "utf-8");
const sessionStorageUsed = source.includes("const playbackStorage = sessionStorage;");
const legacyKeysCleared = source.includes("for (const key of PLAYER_SESSION_KEYS) localStorage.removeItem(key);");
const queueStoredPerPage = source.includes('playbackStorage.setItem("edgesonic:queue"');
const progressStoredPerPage = source.includes('playbackStorage.setItem("edgesonic:currentTime"');

if (sessionStorageUsed && legacyKeysCleared && queueStoredPerPage && progressStoredPerPage) {
  console.log("  ✓ playback state is isolated to the current page session");
} else {
  console.error("  ✗ queue and progress must use sessionStorage and clear legacy keys");
  process.exit(1);
}
