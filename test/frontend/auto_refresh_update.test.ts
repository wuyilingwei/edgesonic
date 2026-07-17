import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/stores/updateBanner.ts"), "utf-8");
const changeCheck = source.includes("initial.value.version !== payload.version || initial.value.buildTime !== payload.buildTime");
const refreshOnChange = source.includes("refresh();");

if (changeCheck && refreshOnChange) {
  console.log("  ✓ detected deployment changes refresh the page automatically");
} else {
  console.error("  ✗ deployment changes must trigger an automatic refresh");
  process.exit(1);
}
