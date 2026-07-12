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

// Re-exported for existing callers (Settings.vue). Not a closed set at
// runtime — an externally-loaded theme can register any id — so `AppTheme`
// is deliberately `string`, not a union of this tuple. This tuple is only
// "the themes always offered, even before their module has loaded".
export const SUPPORTED_THEMES = BUILTIN_THEME_IDS;
export type AppTheme = string;

function initialTheme(): AppTheme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved || "black";
}

function applyTheme(theme: AppTheme) {
  // "black" is the default look already baked into :root — no attribute needed.
  if (theme === "black") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  void ensureBuiltinThemeLoaded(theme);
}

// Reactive so components (e.g. the Stardust background layer) can react to
// a theme switch without a page reload.
export const activeTheme = ref<AppTheme>(initialTheme());
applyTheme(activeTheme.value);
void loadPersistedExternalThemes();

/** Switch UI theme, persist to localStorage, takes effect immediately. */
export function setTheme(theme: AppTheme) {
  activeTheme.value = theme;
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function currentTheme(): AppTheme {
  return activeTheme.value;
}
