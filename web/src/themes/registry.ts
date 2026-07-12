// Theme registry: lets a theme be more than a CSS palette without any
// component (App.vue, PlayerBar.vue, ...) hardcoding that theme's name.
// Built-in themes with behaviour (currently just Stardust) register here
// exactly the same way an externally-loaded theme would — there is no
// separate "built-in" code path.
import { reactive, type Component } from "vue";

export interface ThemeDefinition {
  /** Matches the `data-theme="{id}"` attribute set by theme.ts. */
  id: string;
  label?: string;
  /** Full-viewport decorative background layer, mounted behind the app shell. */
  background?: Component;
  /** Replaces the player bar's default progress-thumb marker. */
  progressThumb?: Component;
  /**
   * Extra px of empty space App.vue reserves at the bottom of the sidebar
   * flex column (0 if omitted). A theme that wants that space to visually
   * bleed into the shared page background does so via its own stylesheet
   * targeting the stable `.sidebar` class — App.vue itself never
   * special-cases any theme id here.
   */
  sidebarFooterHeight?: number;
  /** CSS `background` value for Settings' theme-picker swatch preview. */
  swatchPreview?: string;
}

// Deliberately no separate "loadStyles" hook: a theme's own registering
// module pulls in its CSS as a side-effect import (`import "./x.css"`)
// alongside its components, so one dynamic `import()` — of a build-time
// relative path for a lazy built-in, or a runtime URL for an external
// theme — is the one and only loading mechanism. See themes/builtin.ts
// (lazy built-ins) and loadExternalTheme below (external).
const registry = reactive(new Map<string, ThemeDefinition>());

export function registerTheme(def: ThemeDefinition) {
  registry.set(def.id, def);
}

export function getTheme(id: string): ThemeDefinition | undefined {
  return registry.get(id);
}

export function registeredThemeIds(): string[] {
  return Array.from(registry.keys());
}

const EXTERNAL_THEMES_KEY = "edgesonic_external_themes";

function readExternalThemeUrls(): string[] {
  try {
    const raw = localStorage.getItem(EXTERNAL_THEMES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}
function writeExternalThemeUrls(urls: string[]) {
  localStorage.setItem(EXTERNAL_THEMES_KEY, JSON.stringify(urls));
}

const externalThemeUrlById = new Map<string, string>();

export function externalThemeIds(): string[] {
  return Array.from(externalThemeUrlById.keys());
}

/**
 * Dynamically imports a theme module from `url` and registers its default
 * export. This executes arbitrary JS served from that URL, same as adding
 * a <script> tag pointed at it — only load URLs you trust.
 */
export async function loadExternalTheme(url: string): Promise<ThemeDefinition> {
  const mod: unknown = await import(/* @vite-ignore */ url);
  const def = (mod as { default?: unknown }).default;
  if (!def || typeof def !== "object" || typeof (def as ThemeDefinition).id !== "string" || !(def as ThemeDefinition).id) {
    throw new Error("Theme module must default-export an object with a non-empty string `id`.");
  }
  const themeDef = def as ThemeDefinition;
  registerTheme(themeDef);
  externalThemeUrlById.set(themeDef.id, url);
  const urls = readExternalThemeUrls();
  if (!urls.includes(url)) writeExternalThemeUrls([...urls, url]);
  return themeDef;
}

export function unregisterExternalTheme(id: string) {
  registry.delete(id);
  const url = externalThemeUrlById.get(id);
  externalThemeUrlById.delete(id);
  if (url) writeExternalThemeUrls(readExternalThemeUrls().filter((u) => u !== url));
}

/** Best-effort reload of previously-registered external themes on app boot. */
export async function loadPersistedExternalThemes(): Promise<void> {
  const urls = readExternalThemeUrls();
  await Promise.all(
    urls.map((url) =>
      loadExternalTheme(url).catch((err) => {
        console.warn(`[themes] failed to reload external theme from ${url}:`, err);
      }),
    ),
  );
}
