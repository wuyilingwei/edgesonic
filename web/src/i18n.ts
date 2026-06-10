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

import { createI18n } from "vue-i18n";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

const LANG_KEY = "edgesonic_lang";

function initialLocale(): AppLocale {
  const saved = localStorage.getItem(LANG_KEY);
  return saved === "en" || saved === "zh-CN" ? saved : "zh-CN";
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: "en",
  messages: { "zh-CN": zhCN, en },
});

/** Switch UI language, persist to localStorage, takes effect immediately. */
export function setLocale(locale: AppLocale) {
  i18n.global.locale.value = locale;
  localStorage.setItem(LANG_KEY, locale);
  document.documentElement.setAttribute("lang", locale);
}

export function currentLocale(): AppLocale {
  return i18n.global.locale.value as AppLocale;
}
