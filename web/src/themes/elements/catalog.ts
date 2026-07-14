import type { CrystalBackgroundOptions, DriftMotion } from "../crystal/background";
import type { ParticleConfig } from "./particles";

type Rgb = [number, number, number];

// One 五维介质 element per entry. Shared by index.ts (theme registration +
// backgrounds) and CrystalProgressThumb.vue (the player-bar marker), so the
// progress "片" is the same WebGL tumbling solid as the drifting background
// crystals and the click-drop pieces — never a CSS 3D fake.
export interface ElementTheme {
  id: string;
  label: string;
  color: Rgb;
  halo: Rgb;
  shape: CrystalBackgroundOptions["shape"];
  crystalOpacity: [number, number];
  motion: DriftMotion;
  particle: ParticleConfig;
}

export const ELEMENT_THEMES: ElementTheme[] = [
  {
    id: "gold", label: "Gold SP", color: [1, 0.84, 0.29], halo: [0.11, 0.48, 1],
    shape: "star", crystalOpacity: [0.72, 0.9], motion: "diagonal",
    particle: { kind: "spark", colors: ["#ffe9a8", "#bcd0ff", "#ffffff", "#c7a2ff"], density: 74 },
  },
  {
    id: "ocean", label: "Ocean SP", color: [0.4, 0.78, 0.93], halo: [0.95, 0.66, 0.8],
    shape: "icosahedron", crystalOpacity: [0.5, 0.66], motion: "fall",
    particle: { kind: "bubble", colors: ["#5fbfe6", "#2f8fd0", "#e78bb6"], density: 26 },
  },
  {
    id: "scarlet", label: "Scarlet SP", color: [1, 0.35, 0.12], halo: [1, 0.6, 0.22],
    shape: "tetrahedron", crystalOpacity: [0.5, 0.66], motion: "rise",
    particle: { kind: "ember", colors: ["#ff8a3d", "#ff5a2a", "#ffd06a"], density: 70 },
  },
  {
    id: "sky", label: "Sky SP", color: [0.4, 0.74, 0.55], halo: [0.28, 0.72, 0.66],
    shape: "octahedron", crystalOpacity: [0.5, 0.66], motion: "ltr",
    particle: { kind: "leaf", colors: ["#7fce9e", "#4fb6a0", "#bfe3a0"], density: 26 },
  },
  {
    id: "earth", label: "Earth SP", color: [0.72, 0.47, 0.21], halo: [0.42, 0.26, 0.5],
    shape: "cube", crystalOpacity: [0.5, 0.66], motion: "fall",
    particle: { kind: "dust", colors: ["#e0a233", "#caa26a", "#8a6a4a"], density: 40 },
  },
  {
    id: "crimson", label: "Night SP", color: [0.6, 0.42, 0.9], halo: [0.5, 0.16, 0.42],
    shape: "dodecahedron", crystalOpacity: [0.52, 0.74], motion: "rtl",
    particle: { kind: "orb", colors: ["#9b78e5", "#b98fe0", "#7a2a68"], density: 22 },
  },
];

/** Look up an element by its registered theme id ("sp-gold" → gold entry). */
export function elementVisualFor(themeId: string): ElementTheme | undefined {
  return ELEMENT_THEMES.find((t) => `sp-${t.id}` === themeId);
}
