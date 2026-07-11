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
