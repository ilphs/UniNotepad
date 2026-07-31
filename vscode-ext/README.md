# UniNotepad Markdown Preview

Markdown preview with an **interactive Mermaid layer** — pan, zoom, and a
switchable transparent/solid diagram backdrop — ported from the
[UniNotepad](https://github.com/ilphs/UniNotepad) editor.

VS Code already ships a Markdown preview, so this extension is not trying to
replace it. What it adds is the diagram-handling that UniNotepad built up: a zoom
ladder that scales the document text and the diagrams together, click-and-drag
panning inside an overflowing chart, a per-diagram backdrop you can dial in with
RGBA sliders (useful when a light diagram is unreadable under a dark theme, or
when you want to paste the diagram somewhere with a specific background), and a
full-bleed layout for a standalone `.mmd` file that *is* one diagram.

## Usage

| Action | How |
|---|---|
| Open the preview | `Cmd/Ctrl+K Shift+M`, or the diagram icon in the editor title bar |
| Zoom text + diagrams | `Cmd/Ctrl+=` / `Cmd/Ctrl+-` / `Cmd/Ctrl+0` (preview focused) |
| Pan a zoomed diagram | Click and drag inside it |
| Diagram backdrop | Hover a diagram → **Transparent** / **Backdrop** in its toolbar |
| Export | **UniNotepad: Export Preview as HTML** |

Works on `.md` and on standalone `.mmd` / `.mermaid` files.

There is one preview panel and it **follows the active editor**, like the built-in
one: switch to another Markdown file and the preview switches with you, scrolled
back to the top. Editors it cannot render — a `.ts` file, an output channel, or
the preview itself taking focus — leave the last render in place rather than
blanking the pane.

This sits alongside VS Code's built-in Markdown preview rather than replacing it,
so a `.md` file's title bar carries both buttons. The built-in one keeps the
`open-preview` icon; this extension's is the app's own `<>` diamond — the only
coloured glyph in that toolbar — and its tooltip reads *Open Mermaid Preview to
the Side*.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `uninotepadPreview.mermaidBackgroundEnabled` | `false` | Paint a solid backdrop behind diagrams |
| `uninotepadPreview.mermaidBackground` | `255,255,255,1` | Backdrop as `r,g,b,a` — normally edited by the in-diagram popover |
| `uninotepadPreview.scrollEditorWithPreview` | `true` | Sync preview scroll to the editor (one-way) |

## Known gaps

These are real limitations of this version, not oversights:

- **Fenced code blocks are not syntax-highlighted.** UniNotepad highlights them by
  reusing CodeMirror's own grammars, which means one dynamic import per language —
  and a webview can only load resources through `asWebviewUri`, so a split bundle's
  chunk fetches are blocked by the Content-Security-Policy. Getting this back means
  swapping in a highlighter that fits a single bundle.
- **No printing.** VS Code webviews cannot call `window.print()` — the sandbox has
  no `allow-modals`. Export to HTML and print from a browser; the export command
  offers to open the file for you.
- **`#anchor` links mostly miss.** `marked` does not generate heading slugs by
  default, so there is usually no matching `id` to scroll to.
- **Scroll sync is one-way** (editor → preview), matching UniNotepad. Scrolling the
  preview does not move the editor.

## Development

```bash
npm install
npm run typecheck   # both bundles: extension host and webview
npm run test        # build, then 49 assertions across both runtimes
npm run build       # dist/extension.js + dist/webview.js
npm run watch
```

Open **`vscode-ext/` as the workspace folder** (not the repository root) and press
`F5`; the launch configuration builds, starts an Extension Development Host, and
opens `sample/demo.md`, which is a checklist for the things the tests cannot reach.

`test/` runs both halves outside VS Code: `extension-host.test.cjs` drives
`dist/extension.js` against a stub `vscode` module, and `webview.test.cjs` runs
`dist/webview.js` in jsdom with a stubbed `acquireVsCodeApi`. The one thing neither
covers is Mermaid's SVG output — mermaid measures text with `getBBox`, which jsdom
does not implement, so a diagram deliberately lands in the error path there. Verify
diagrams by eye via `F5`.

`npm run package` builds a `.vsix`. The `publisher` in `package.json` is `ilphs`,
which must stay in sync with the Marketplace publisher the `.vsix` is uploaded
under — a mismatch is rejected at upload time.

### Layout

```
src/        extension host — commands, panel lifecycle, document sync
webview/    the preview itself — render core + Mermaid interaction layer
shared/     the message contract both sides import
media/      preview.css, icon.png (gallery icon), toolbar-icon-{light,dark}.svg
```

`media/icon.png` is a copy of the app's own icon (`src-tauri/icons/128x128@2x.png`,
256×256) so the extension is recognisable as part of UniNotepad. It is a copy for
the same reason `site/assets/app-icon.png` is: each deliverable packages
independently. Re-copy it if the app icon changes.

The two `toolbar-icon-*.svg` files are that same icon redrawn for a **16×16**
title-bar slot: the black rounded square is dropped (at 16px it swallowed the
whole glyph — invisible against a dark toolbar, a heavy black block against a
light one) and only the `<>` diamond survives, keeping the app's cyan `#51D7FF`
→ violet `#AE59EF` gradient and its mirrored direction on the two strokes. The
light variant is the same two hues at lower lightness, because the cyan end
washes out on white. Re-derive them if the app icon's palette changes.

`webview/mermaid-view.ts` and `webview/preview.ts` are ports of the same files in
UniNotepad's `src/`. They are **copies, not a shared module**: the app keys its
state off a tab store and `localStorage`, the extension off a panel and
`workspace.getConfiguration`. Fixes to the Mermaid layout and zoom rules generally
apply to both and should be made in both.

## License

MIT
