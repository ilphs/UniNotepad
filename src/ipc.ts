import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
  /** Per-tab layout/zoom (absent in older manifests → fall back to the global
   *  defaults on restore). Rust round-trips these untyped, like the fields above. */
  previewRatio?: number | null;
  editorFontSize?: number | null;
  previewZoomExp?: number | null;
}

export interface SessionManifest {
  version: number;
  activeTabId: string | null;
  nextUntitled: number;
  tabs: TabEntry[];
}

export interface LoadedSession {
  manifest: SessionManifest;
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

  // Watch/unwatch are best-effort: a failed watch just means no live updates
  // (the focus-mtime fallback still catches changes), so errors are swallowed.
  watchFile: (path: string) => invoke<void>("watch_file", { path }).catch(() => {}),
  unwatchFile: (path: string) => invoke<void>("unwatch_file", { path }).catch(() => {}),

  // Rebuild the native menu so its "Open Recent" submenu reflects `paths`
  // (newest first). Best-effort: a failure just leaves the last-good menu.
  setRecentFiles: (paths: string[]) =>
    invoke<void>("set_recent_files", { paths }).catch(() => {}),

  loadSession: () => invoke<LoadedSession | null>("load_session"),
  persistSession: (manifestJson: string, dirtyBackups: [string, string][]) =>
    invoke<void>("persist_session", { manifestJson, dirtyBackups }),
  deleteBackup: (tabId: string) => invoke<void>("delete_backup", { tabId }),

  frontendReady: () => invoke<void>("frontend_ready"),
};

export function onOpenPaths(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>("open-paths", (e) => cb(e.payload));
}

export function onMenu(cb: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>("menu", (e) => cb(e.payload));
}

/** Fires when a watched file changes on disk (created/modified/deleted). */
export function onFileChanged(cb: (p: FileChangedPayload) => void): Promise<UnlistenFn> {
  return listen<FileChangedPayload>("file-changed", (e) => cb(e.payload));
}

/** Fires when the user drags file(s) from the OS file explorer onto the app window. */
export function onFileDrop(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") cb(e.payload.paths);
  });
}
