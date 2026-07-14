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

// Catalog of built-in themes. Importing this module (done once from
// theme.ts) registers the plain palette themes immediately — they're just
// a few bytes of metadata, no behaviour, so there's no reason to defer
// them. The animated SP themes have real weight (WebGL + particles + their
// own stylesheet), so they're loaded lazily via dynamic import, the same
// "import a module that calls registerTheme" path `loadExternalTheme` uses
// for a runtime URL — see registry.ts.
import { registerTheme, getTheme } from "./registry";

export const THEME_PICKER_ROWS = [
  ["black", "color-gold", "color-ocean", "color-scarlet", "color-sky", "color-earth", "color-crimson"],
  ["white", "sp-gold", "sp-ocean", "sp-scarlet", "sp-sky", "sp-earth", "sp-crimson"],
] as const;
export const BUILTIN_THEME_IDS = THEME_PICKER_ROWS.flat();

registerTheme({ id: "black", label: "Black", swatchPreview: "#0a0a0b" });
registerTheme({ id: "white", label: "White", swatchPreview: "#f7f8fc" });
registerTheme({ id: "color-gold", label: "Gold", swatchPreview: "#ffd64a" });
registerTheme({ id: "color-scarlet", label: "Scarlet", swatchPreview: "#f43d4f" });
registerTheme({ id: "color-ocean", label: "Ocean", swatchPreview: "#65c7ec" });
registerTheme({ id: "color-sky", label: "Sky", swatchPreview: "#65bd8c" });
registerTheme({ id: "color-earth", label: "Earth", swatchPreview: "#df9541" });
registerTheme({ id: "color-crimson", label: "Crimson", swatchPreview: "#bf3967" });

const lazyBuiltins: Record<string, () => Promise<unknown>> = {
  "sp-gold": () => import("./elements"),
  "sp-scarlet": () => import("./elements"),
  "sp-ocean": () => import("./elements"),
  "sp-sky": () => import("./elements"),
  "sp-earth": () => import("./elements"),
  "sp-crimson": () => import("./elements"),
};

/** No-ops once a theme is already registered (covers both "already lazy-loaded" and "not a lazy built-in"). */
export async function ensureBuiltinThemeLoaded(id: string): Promise<void> {
  if (getTheme(id) || !(id in lazyBuiltins)) return;
  await lazyBuiltins[id]();
}
