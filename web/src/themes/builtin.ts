// Catalog of built-in themes. Importing this module (done once from
// theme.ts) registers the plain palette themes immediately — they're just
// a few bytes of metadata, no behaviour, so there's no reason to defer
// them. Stardust has real weight (two components + its own stylesheet), so
// it's loaded lazily via dynamic import, exactly the same
// "import a module that calls registerTheme" path `loadExternalTheme` uses
// for a runtime URL — see registry.ts.
import { registerTheme, getTheme } from "./registry";

export const BUILTIN_THEME_IDS = ["black", "red", "green", "yellow", "stardust"] as const;

registerTheme({ id: "black", label: "Black", swatchPreview: "#0a0a0b" });
registerTheme({ id: "red", label: "Red", swatchPreview: "#e53d3d" });
registerTheme({ id: "green", label: "Green", swatchPreview: "#1ed760" });
registerTheme({ id: "yellow", label: "Yellow", swatchPreview: "#f5c518" });

const lazyBuiltins: Record<string, () => Promise<unknown>> = {
  stardust: () => import("./stardust"),
};

/** No-ops once a theme is already registered (covers both "already lazy-loaded" and "not a lazy built-in"). */
export async function ensureBuiltinThemeLoaded(id: string): Promise<void> {
  if (getTheme(id) || !(id in lazyBuiltins)) return;
  await lazyBuiltins[id]();
}
