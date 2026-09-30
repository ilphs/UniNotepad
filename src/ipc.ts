import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { EncodingId, EolId, FileTypeId } from "./state";

export interface OpenedFile {
  content: string;
  encoding: EncodingId;
  eol: EolId;
  mtimeMs: number | null;
  /** True when some bytes could not be decoded and were replaced (U+FFFD). */
  lossy: boolean;
  /** File size in bytes, from the pre-read stat. */
  sizeBytes: number;
  /** True when the file is over the warn threshold and allowLarge was not set:
   *  nothing was read (content is empty) and the caller must confirm first. */
  needsLargeConfirm: boolean;
  /** True whenever the file is over the warn threshold — signals reduced mode
   *  (no highlighting, no crash backup) even after the user approves. */
  large: boolean;
}

export interface SavedFile {
  mtimeMs: number | null;
  /** False when a lossy save was skipped because allowLossy was not set. */
  written: boolean;
  /** True when the chosen encoding cannot represent every character. */
  lossy: boolean;
}

export interface FileStat {
  exists: boolean;
  mtimeMs: number | null;
}

/** Verdict on a link target found inside a document (see resolve_link). */
export interface ResolvedLink {
  /** Absolute path the link points at, canonicalized when it exists. */
  path: string;
  exists: boolean;
  isDir: boolean;
  /** True when the file looks binary (NUL in its first bytes). */
  binary: boolean;
}

/** Emitted by the backend when a watched file changes on disk. `path` echoes
 *  the exact string passed to watchFile, so it matches a tab's `path`. */
export interface FileChangedPayload {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
}

export interface TabEntry {
  id: string;
  path: string | null;
  title: string;
  dirty: boolean;
  hasBackup: boolean;
  encoding: EncodingId | null;
  eol: EolId | null;
  /** Rust round-trips this untyped, so treat it as untrusted on read. */
  fileType: FileTypeId | null;
  diskMtimeMs: number | null;
  /** Whether this tab loaded in large-file reduced mode (absent in older
   *  manifests → treated as false). */
  largeFile: boolean;
  cursor: number | null;
  scrollTop: number | null;
  /** Per-tab layout/zoom + pane visibility (absent in older manifests → fall
   *  back to the global defaults on restore). These are modelled explicitly in
   *  Rust's `TabEntry`; anything not named there is dropped on the way back out
   *  of `load_session`, so adding a field here means adding it there too. */
  previewRatio?: number | null;
  editorFontSize?: number | null;
  previewZoomExp?: number | null;
  editorVisible?: boolean | null;
  previewVisible?: boolean | null;
}

/** This window's slice of `session.json`. Rust merges every window's slice
 *  into one versioned manifest (see `session/model.rs`), so the frontend never
 *  sees — or writes — other windows' tabs or the file's version. */
export interface WindowSession {
  activeTabId: string | null;
  nextUntitled: number;
  tabs: TabEntry[];
}

export interface LoadedSession {
  session: WindowSession;
  backups: Record<string, string>;
}

export const ipc = {
  openFile: (path: string, allowLarge = false) =>
    invoke<OpenedFile>("open_file", { path, allowLarge }),
  openFileAs: (path: string, encoding: EncodingId, allowLarge = false) =>
    invoke<OpenedFile>("open_file_as", { path, encoding, allowLarge }),
  saveFile: (
    path: string,
    content: string,
    encoding: EncodingId,
    eol: EolId,
    allowLossy: boolean,
  ) => invoke<SavedFile>("save_file", { path, content, encoding, eol, allowLossy }),
  statFile: (path: string) => invoke<FileStat>("stat_file", { path }),

  /** Resolve a document link target against the file that contains it. `href`
   *  must already be fragment-free, unwrapped and percent-decoded. */
  resolveLink: (base: string, href: string) =>
    invoke<ResolvedLink>("resolve_link", { base, href }),

  // Watch/unwatch are best-effort: a failed watch just means no live updates
  // (the focus-mtime fallback still catches changes), so errors are swallowed.
  watchFile: (path: string) => invoke<void>("watch_file", { path }).catch(() => {}),
  unwatchFile: (path: string) => invoke<void>("unwatch_file", { path }).catch(() => {}),

  // Rebuild the native menu so its "Open Recent" submenu reflects `paths`
  // (newest first). Best-effort: a failure just leaves the last-good menu.
  setRecentFiles: (paths: string[]) =>
    invoke<void>("set_recent_files", { paths }).catch(() => {}),
  syncThemeMenu,

  // Both are scoped to the calling window by Rust (its label picks the slot).
  loadSession: () => invoke<LoadedSession | null>("load_session"),
  persistSession: (sessionJson: string, dirtyBackups: [string, string][]) =>
    invoke<void>("persist_session", { sessionJson, dirtyBackups }),
  deleteBackup: (tabId: string) => invoke<void>("delete_backup", { tabId }),

  frontendReady: () => invoke<void>("frontend_ready"),

  // Multi-window — src-tauri/src/windows.rs (+ forget_window in
  // commands/session.rs). The close trio is sequenced by src/windows.ts.
  newWindow: () => invoke<void>("new_window"),
  /** Resolves true when this is the last window (its tabs stay for next launch). */
  beginCloseWindow: () => invoke<boolean>("begin_close_window"),
  cancelCloseWindow: () => invoke<void>("cancel_close_window"),
  /** Drop this window's tabs from the session for good (non-last close). */
  forgetWindow: () => invoke<void>("forget_window"),
  // Best-effort: a lost update only costs cross-window de-duplication.
  setOpenPaths: (paths: string[]) =>
    invoke<void>("set_open_paths", { paths }).catch(() => {}),
  /** True when another window had `path` open and has been brought forward
   *  with that tab active; on failure, fall back to opening it here. */
  focusPathOwner: (path: string) =>
    invoke<boolean>("focus_path_owner", { path }).catch(() => false),
};

/** Rebuild the native menu so View ▸ Theme's check marks show `family` (e.g.
 *  "dracula") and `mode` ("light" | "dark" | "system"). The theme itself is
 *  owned by the frontend, so this only mirrors an already-applied change.
 *  Best-effort and fire-and-forget: a failure just leaves the last-good menu,
 *  and callers must not have to await a cosmetic update. */
export function syncThemeMenu(family: string, mode: string): void {
  void invoke<void>("set_theme_menu", { family, mode }).catch(() => {});
}

// `open-paths` and `menu` are window-scoped: Rust sends each to one window
// (the last focused) with `emit_to`. They must be heard through
// `getCurrentWebviewWindow().listen`, which subscribes for this window's label
// only. The global `listen` subscribes with target `Any`, and Tauri delivers
// every event to an `Any` listener regardless of its target — so with it, a
// menu click aimed at one window would still run in all of them.

export function onOpenPaths(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<string[]>("open-paths", (e) => cb(e.payload));
}

export function onMenu(cb: (id: string) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<string>("menu", (e) => cb(e.payload));
}

/** Fires when a watched file changes on disk (created/modified/deleted).
 *  Deliberately app-wide (Rust broadcasts it, global `listen` here): the same
 *  file can be open in several windows, and each one reconciles only its own
 *  tabs by path, so a window without the file just ignores it. */
export function onFileChanged(cb: (p: FileChangedPayload) => void): Promise<UnlistenFn> {
  return listen<FileChangedPayload>("file-changed", (e) => cb(e.payload));
}

/** Fires when the user drags file(s) from the OS file explorer onto the app window. */
export function onFileDrop(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") cb(e.payload.paths);
  });
}
