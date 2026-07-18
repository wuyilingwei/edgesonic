import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/stores/updateBanner.ts"), "utf-8");
const mainSource = fs.readFileSync(path.resolve(__dirname, "../../web/src/main.ts"), "utf-8");
const changeCheck = source.includes("hasUpdate(initial.value, payload)");
const refreshOnChange = source.includes("refresh();");
const bundleBaseline = mainSource.includes("version: __EDGESONIC_VERSION__") &&
  mainSource.includes("buildTime: __EDGESONIC_BUILD_TIME__");

if (changeCheck && refreshOnChange && bundleBaseline) {
  console.log("  ✓ deployment changes refresh from the loaded bundle baseline");
} else {
  console.error("  ✗ deployment changes must compare against the loaded bundle and refresh automatically");
  process.exit(1);
}
