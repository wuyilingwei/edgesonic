import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function getBuildInfo() {
  const tag = git(["describe", "--exact-match", "--tags", "HEAD"]);
  const revision = git(["rev-parse", "--short", "HEAD"]) || "unknown";
  const dirty = Boolean(git(["status", "--porcelain"]));
  const version = tag?.replace(/^v/, "") || `${pkg.version}-dev.${revision}`;
  return {
    version: process.env.EDGESONIC_VERSION || `${version}${dirty ? "-dirty" : ""}`,
    buildTime: process.env.EDGESONIC_BUILD_TIME || new Date().toISOString(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(getBuildInfo()));
}
