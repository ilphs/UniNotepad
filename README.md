# UniNotepad

A lightweight, cross-platform (Windows / macOS / Linux) plain-text editor with
tabs and **Notepad++-style session persistence**: your open tabs — including
unsaved edits and brand-new untitled documents — survive an app quit, a crash,
or a full computer restart, and reappear exactly as you left them the next time
you open the app. No manual save required.

Syntax highlighting is available for common extensions (py, json, sql, java,
sh/bash, html, css, js/jsx, ts/tsx, …); other files open as plain text.

## Stack

- **[Tauri 2](https://tauri.app)** — Rust backend + the OS-native WebView (tiny binary, no bundled browser)
- **[CodeMirror 6](https://codemirror.dev)** — editor component (state/view/commands/search only, no language packages)
- **Vanilla TypeScript + Vite** — no frontend framework runtime

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Linux only: `webkit2gtk-4.1` and `libgtk-3` dev packages

## Develop

```bash
npm install
npm run tauri dev      # launches the app with hot-reload
```

## Build

```bash
npm run tauri build    # produces platform installers under src-tauri/target/release/bundle/
```

## Test

```bash
# Rust: encoding round-trips + session-store durability (atomic write, corrupt quarantine, GC)
cd src-tauri && cargo test

# Frontend typecheck + production bundle
npm run build
```

## How session persistence works

- Session data lives in the per-OS app data dir (`app_data_dir()`):
  a `session.json` manifest + one backup file per dirty/untitled tab under `backups/`.
- Dirty buffers are flushed on a 1.5 s edit debounce, on tab switch, on window
  blur, on structural changes, on a 30 s safety interval, and on window close.
- Every write is atomic (temp file → fsync → rename), so a `kill -9` or power
  loss never corrupts a file — at most the last debounce window is lost.
- On startup the manifest is read and each tab reconciled against disk:
  clean files are re-read; dirty files restore your backup (your edits win) and
  show a non-blocking banner if the file changed or was deleted on disk.

## Behavior notes (Notepad++ parity)

- **Quitting the app never prompts** — everything is persisted and restored.
- **Explicitly closing a dirty tab** prompts Save / Don't Save / Cancel.

## Manual acceptance test (session restore)

1. `npm run tauri dev`, open a couple of files, edit one, create 1–2 untitled tabs with text.
2. Force-kill the process (`kill -9 <pid>` or Activity Manager / Task Manager).
3. Relaunch — all tabs return in order, with the active tab, cursor positions,
   dirty markers, and untitled content intact.
