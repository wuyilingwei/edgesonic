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

import { registerTheme } from "../registry";
import { mountCrystalBackground } from "../crystal/background";
import { mountParticles } from "./particles";
import { ELEMENT_THEMES } from "./catalog";
import CrystalProgressThumb from "../crystal/CrystalProgressThumb.vue";
import "./elements.css";

for (const theme of ELEMENT_THEMES) {
  registerTheme({
    id: `sp-${theme.id}`,
    label: theme.label,
    progressThumb: CrystalProgressThumb,
    mountBackground: (host) => {
      const stopCrystal = mountCrystalBackground(host, {
        color: theme.color,
        halo: theme.halo,
        shape: theme.shape,
        opacity: theme.crystalOpacity,
        motion: theme.motion,
        backgroundClass: "el-bg",
        fallClass: "el-fall-layer",
      });
      const stopParticles = mountParticles(host, theme.particle);
      return () => { stopParticles(); stopCrystal(); };
    },
    swatchPreview: `radial-gradient(circle at 72% 28%, rgb(${theme.color.map((part) => Math.round(part * 255)).join(" ")}) 0 12%, transparent 13%), linear-gradient(135deg, #0c1020, #273251)`,
  });
}
