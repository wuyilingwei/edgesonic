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

const THEME_KEY = "edgesonic_theme";

export const SUPPORTED_THEMES = ["black", "red", "green", "yellow", "stardust"] as const;
export type AppTheme = (typeof SUPPORTED_THEMES)[number];

function initialTheme(): AppTheme {
  const saved = localStorage.getItem(THEME_KEY);
  return (SUPPORTED_THEMES as readonly string[]).includes(saved ?? "") ? (saved as AppTheme) : "black";
}

function applyTheme(theme: AppTheme) {
  // "black" is the default look already baked into :root — no attribute needed.
  if (theme === "black") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

// Reactive so components (e.g. App.vue's stardust background layer) can react
// to a theme switch without a page reload.
export const activeTheme = ref<AppTheme>(initialTheme());
applyTheme(activeTheme.value);

/** Switch UI theme, persist to localStorage, takes effect immediately. */
export function setTheme(theme: AppTheme) {
  activeTheme.value = theme;
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function currentTheme(): AppTheme {
  return activeTheme.value;
}
