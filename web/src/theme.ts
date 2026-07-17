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

import { ref } from "vue";
import { BUILTIN_THEME_IDS, ensureBuiltinThemeLoaded } from "./themes/builtin";
import { loadPersistedExternalThemes } from "./themes/registry";

const THEME_KEY = "edgesonic_theme";
const LEGACY_THEME_IDS: Record<string, AppTheme> = { stardust: "sp-gold", red: "color-scarlet", green: "color-sky", yellow: "color-earth" };

// Re-exported for existing callers (Settings.vue). Not a closed set at
// runtime — an externally-loaded theme can register any id — so `AppTheme`
// is deliberately `string`, not a union of this tuple. This tuple is only
// "the themes always offered, even before their module has loaded".
export const SUPPORTED_THEMES = BUILTIN_THEME_IDS;
export type AppTheme = string;

function applyTheme(theme: AppTheme) {
  if (theme === "black") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export const activeTheme = ref<AppTheme>("black");
applyTheme(activeTheme.value);

/** Switch UI theme, persist to localStorage, takes effect immediately. */
export function setTheme(theme: AppTheme) {
  activeTheme.value = theme;
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  void ensureBuiltinThemeLoaded(theme);
}

export async function restoreSavedTheme() {
  const saved = LEGACY_THEME_IDS[localStorage.getItem(THEME_KEY) || ""] || localStorage.getItem(THEME_KEY) || "black";
  activeTheme.value = saved;
  localStorage.setItem(THEME_KEY, saved);
  applyTheme(saved);
  await Promise.all([ensureBuiltinThemeLoaded(saved), loadPersistedExternalThemes()]);
}

export function resetTheme() {
  activeTheme.value = "black";
  applyTheme("black");
}
