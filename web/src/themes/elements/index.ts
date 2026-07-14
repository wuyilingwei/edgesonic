import { registerTheme } from "../registry";
import { mountCrystalBackground } from "../crystal/background";
import { mountParticles } from "./particles";
import { ELEMENT_THEMES } from "./catalog";
import CrystalProgressThumb from "../crystal/CrystalProgressThumb.vue";
import "./elements.css";

for (const theme of ELEMENT_THEMES) {
  registerTheme({
    id: `sp-${theme.id}`,
    label: theme.label,
    progressThumb: CrystalProgressThumb,
    mountBackground: (host) => {
      const stopCrystal = mountCrystalBackground(host, {
        color: theme.color,
        halo: theme.halo,
        shape: theme.shape,
        opacity: theme.crystalOpacity,
        motion: theme.motion,
        backgroundClass: "el-bg",
        fallClass: "el-fall-layer",
      });
      const stopParticles = mountParticles(host, theme.particle);
      return () => { stopParticles(); stopCrystal(); };
    },
    swatchPreview: `radial-gradient(circle at 72% 28%, rgb(${theme.color.map((part) => Math.round(part * 255)).join(" ")}) 0 12%, transparent 13%), linear-gradient(135deg, #0c1020, #273251)`,
  });
}
