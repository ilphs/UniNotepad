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
    // The language grammars now load as dynamic chunks (src/language.ts), so the
    // entry stays lean. This lowered limit is a regression guard: if a grammar's
    // static import ever creeps back into the entry chunk, the build warns.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // Keep the always-loaded CodeMirror runtime (view/state/commands/…) in
        // its own vendor chunk instead of letting rolldown fold it into the app
        // entry. This is purely a code-organization split — the same bytes load
        // at startup either way — but it keeps the app entry small and readable.
        //
        // Crucially it must NOT capture the per-language grammars: @codemirror/
        // lang-* and @codemirror/legacy-modes stay excluded so they keep
        // code-splitting into their own lazy chunks (loaded only on demand).
        advancedChunks: {
          groups: [
            {
              name: "codemirror",
              test: /[\\/]node_modules[\\/](@codemirror[\\/](?!lang-|legacy-modes)[^\\/]+|@lezer[\\/](common|highlight)|style-mod|crelt|w3c-keyname)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
