// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const tag = git(["describe", "--exact-match", "--tags", "HEAD"]);
const revision = git(["rev-parse", "--short", "HEAD"]) || "unknown";
const version = process.env.EDGESONIC_VERSION || (
  tag?.replace(/^v/, "") || `${pkg.version}-dev.${revision}`
);
const buildTime = process.env.EDGESONIC_BUILD_TIME || new Date().toISOString();

export default defineConfig({
  plugins: [vue()],
  server: { port: 5173 },
  define: {
    __EDGESONIC_VERSION__: JSON.stringify(version),
    __EDGESONIC_BUILD_TIME__: JSON.stringify(buildTime),
  },
});
