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
