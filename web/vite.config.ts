import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  plugins: [vue()],
  server: { port: 5173 },
  define: {
    __EDGESONIC_VERSION__: JSON.stringify(pkg.version),
  },
});
