import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { EncodingId, EolId, FileTypeId } from "./state";

export interface OpenedFile {
  content: string;
  encoding: EncodingId;
  eol: EolId;
  mtimeMs: number | null;
}

export interface SavedFile {
  mtimeMs: number | null;
}

export interface FileStat {
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
  cursor: number | null;
  scrollTop: number | null;
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
  openFile: (path: string) => invoke<OpenedFile>("open_file", { path }),
  saveFile: (path: string, content: string, encoding: EncodingId, eol: EolId) =>
    invoke<SavedFile>("save_file", { path, content, encoding, eol }),
  statFile: (path: string) => invoke<FileStat>("stat_file", { path }),

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

/** Fires when the user drags file(s) from the OS file explorer onto the app window. */
export function onFileDrop(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") cb(e.payload.paths);
  });
}
