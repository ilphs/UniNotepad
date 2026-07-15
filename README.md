# UniNotepad

A lightweight, cross-platform (Windows / macOS / Linux) plain-text editor with
tabs and **Notepad++-style session persistence**: your open tabs — including
unsaved edits and brand-new untitled documents — survive an app quit, a crash,
or a full computer restart, and reappear exactly as you left them the next time
you open the app. No manual save required.

## Syntax highlighting

**143 languages / 224 extensions**, picked from the file name — no mode menu, no configuration.

Everyday languages (JSON, JS/TS, Python, C/C++, Rust, Go, HTML/CSS, Markdown,
YAML, XML, SQL, Java, shell) are bundled and highlight the instant the file opens.
Everything else is matched against
[`@codemirror/language-data`](https://github.com/codemirror/language-data) and its
language pack is fetched on first use, as its own chunk — so the long tail costs
nothing at startup.

The tail covers web (LESS/SCSS/Vue/Pug/Handlebars), systems (Swift/Objective-C/D/
Fortran/Cobol/assembly), JVM and .NET (Kotlin/Scala/Groovy/Clojure/C#/F#/VB.NET),
scripting (Ruby/Perl/PHP/Lua/PowerShell/Tcl/R/Julia), functional (Haskell/Elm/
Erlang/OCaml/Lisp/Scheme), data and config (TOML/INI/ProtoBuf/LaTeX/diff),
databases (Cypher/XQuery/PL-SQL and the SQL dialects), and hardware description
(Verilog/SystemVerilog/VHDL).

Files with no extension are recognized by name: `Dockerfile`, `CMakeLists.txt`,
`Jenkinsfile`, `Gemfile`, `Rakefile`, `BUILD`, `PKGBUILD`, `nginx*.conf`.

Anything unmatched opens as plain text.

### What it looks like

Highlighting and the Markdown preview both follow the active light/dark theme.

| | |
|:--|:--|
| **Markdown** — split preview, live as you type | **Mermaid** — a `.mmd` file renders as one diagram |
| ![Markdown with split preview](docs/syntax-markdown.png) | ![Mermaid diagram preview](docs/syntax-mermaid.png) |
| **Bash** — comments, keywords, expansions | **HTML** — nested CSS and JavaScript |
| ![Bash syntax highlighting](docs/syntax-bash.png) | ![HTML syntax highlighting](docs/syntax-html.png) |

## Stack

- **[Tauri 2](https://tauri.app)** — Rust backend + the OS-native WebView (tiny binary, no bundled browser)
- **[CodeMirror 6](https://codemirror.dev)** — editor component; common language packs bundled, the rest lazy-loaded per language
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
