import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { fileURLToPath } from "node:url";

// Los paquetes del repo se publican como TypeScript: se empaquetan en vez de externalizarse.
const bundled = { externalizeDeps: { exclude: ["@clanker/api", "@clanker/ui"] } };

export default defineConfig({
  main: { build: bundled },
  preload: { build: { ...bundled, rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: {
    // El código de la UI importa con `@/...`: apunta a su propio src.
    resolve: { alias: { "@": fileURLToPath(new URL("../../packages/ui/src", import.meta.url)) } },
    server: { port: 8890 },
    plugins: [react(), tailwindcss()],
  },
});
