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
import { getBuildInfo } from "../scripts/build-info.mjs";

const { version, buildTime } = getBuildInfo();

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "edgesonic-build-info",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build-info.json",
          source: JSON.stringify({ version, buildTime }),
        });
      },
    },
  ],
  server: { port: 5173 },
  define: {
    __EDGESONIC_VERSION__: JSON.stringify(version),
    __EDGESONIC_BUILD_TIME__: JSON.stringify(buildTime),
  },
});
