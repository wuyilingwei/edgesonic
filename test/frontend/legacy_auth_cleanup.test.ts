import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../web/src/api.ts"), "utf-8");
if (source.includes('localStorage.removeItem("edgesonic_auth")')) {
  console.log("  ✓ legacy credential-shaped auth storage is cleared on startup");
} else {
  console.error("  ✗ legacy auth storage must be cleared on startup");
  process.exit(1);
}
