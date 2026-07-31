# Changelog

## 0.1.3 — 2026-07-31

- **Fixed: clicking a link in the preview opened it twice, so the "Do you want Code
  to open the external website?" prompt appeared to be ignored — the browser opened
  whichever button you pressed, Cancel included.** The webview's link handler
  cancelled the default action but let the click keep bubbling, and VS Code's own
  preload listens on `window` without checking `defaultPrevented`, so it opened the
  link a second time on its own. The click now stops at the preview host.

## 0.1.2 — 2026-07-31

- The preview tab now shows UniNotepad's `<>` diamond instead of VS Code's default
  webview icon, matching the title-bar button. Set on every panel including ones
  restored after a window reload, since the icon is not serialized with the panel.

## 0.1.1 — 2026-07-31

- The editor title-bar button now carries UniNotepad's own `<>` diamond instead of
  the generic `type-hierarchy` codicon, with separate light and dark variants so the
  cyan end of the gradient stays legible on a white toolbar.

## 0.1.0 — 2026-07-31

First release. The Mermaid handling from the [UniNotepad](https://github.com/ilphs/UniNotepad)
editor, as a preview panel.

- Markdown preview for `.md`, and a full-bleed layout for standalone `.mmd` / `.mermaid` files
- Zoom ladder that scales document text and diagrams together (`Cmd/Ctrl+=` / `-` / `0`)
- Click-and-drag panning inside a diagram that overflows its box
- Per-diagram backdrop with RGBA sliders, switchable between transparent and solid
- One preview panel that follows the active editor, with one-way scroll sync from the editor
- **UniNotepad: Export Preview as HTML**

Known gaps in this version — fenced code blocks are not syntax-highlighted, the webview
cannot print, and `#anchor` links usually have no target. See the README for why.
