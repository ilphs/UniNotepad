import { defineConfig } from "vite";

// Tauri expects a fixed port and no clearing of the console during dev.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // tauri sources are watched by cargo, not vite
      ignored: ["**/src-tauri/**"],
    },
  },
  // Produce a lean, modern bundle — WebViews on all target OSes support ES2021.
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
