import * as fs from "node:fs";
import * as path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../scripts/build-info.mjs"), "utf-8");
const detectsDirtyWorktree = source.includes('git(["status", "--porcelain"])');
const preservesVersionKind = source.includes('tag?.replace(/^v/, "") || `${pkg.version}-dev.${revision}`');
const appendsDirtyMarker = source.includes('`${version}${dirty ? "-dirty" : ""}`');

if (detectsDirtyWorktree && preservesVersionKind && appendsDirtyMarker) {
  console.log("  ✓ dirty worktrees have a separate version marker");
} else {
  console.error("  ✗ uncommitted changes must be marked separately from development versions");
  process.exit(1);
}
