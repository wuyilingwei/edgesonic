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

export function currentTheme(): AppTheme {
  return activeTheme.value;
}
