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

// Loaded lazily via themes/builtin.ts's dynamic import — the exact same
// "import a module, it calls registerTheme" path an external theme module
// uses (see registry.ts's loadExternalTheme), just at a build-time-known
// specifier instead of a runtime URL. Importing this module is what pulls
// in both Stardust's components and its CSS.
import { registerTheme } from "../registry";
import StardustBackground from "./StardustBackground.vue";
import StardustProgressThumb from "./StardustProgressThumb.vue";
import "./stardust.css";

// Keep in sync with stardust.css's `.sidebar` gradient stop.
const SIDEBAR_FOOTER_HEIGHT = 84;

registerTheme({
  id: "stardust",
  label: "Stardust",
  background: StardustBackground,
  progressThumb: StardustProgressThumb,
  sidebarFooterHeight: SIDEBAR_FOOTER_HEIGHT,
  swatchPreview:
    "radial-gradient(circle at 72% 24%, #ffd64a 0 12%, transparent 13%), " +
    "linear-gradient(135deg, #050611 0 34%, #12193a 34% 58%, #7a4dff 58% 76%, #1c7bff 100%)",
});
