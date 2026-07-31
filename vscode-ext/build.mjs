/**
 * Two bundles, because the extension host and the webview are two runtimes:
 *
 *   dist/extension.js — Node (CommonJS). `vscode` is provided by the host at
 *                       runtime, so it must stay external or esbuild will try to
 *                       resolve a module that does not exist on disk.
 *   dist/webview.js   — browser (IIFE, no code splitting).
 *
 * `splitting: false` on the webview bundle is a hard requirement, not a default we
 * happened to leave alone. A split build emits sibling chunks that the bundle
 * fetches by relative URL, and a webview can only load resources through
 * `asWebviewUri` under its Content-Security-Policy — so those fetches would be
 * blocked with no way to rewrite them. One file costs bundle size (mermaid is the
 * bulk of it) and buys a build that actually loads. It also means the dynamic
 * `import()`s in preview.ts get inlined rather than becoming requests, which is
 * why that file can keep the app's lazy-load shape verbatim.
 */
import * as esbuild from "esbuild";
import { rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

// Clear the directory rather than letting esbuild overwrite in place: a
// production build emits no sourcemaps, so a `.map` from an earlier dev build
// would survive and the shipped `//# sourceMappingURL` comment would be gone
// while the stale file sat next to it.
if (!watch) await rm("dist", { recursive: true, force: true });

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import("esbuild").BuildOptions} */
const extensionConfig = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
};

/** @type {import("esbuild").BuildOptions} */
const webviewConfig = {
  ...common,
  entryPoints: ["webview/main.ts"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2021",
  splitting: false,
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching…");
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
