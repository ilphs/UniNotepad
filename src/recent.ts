/**
 * Most-recently-opened file paths, persisted in localStorage (theme.ts pattern).
 * The list is surfaced two ways that stay in sync: the native "Open Recent"
 * submenu (rebuilt in Rust via setRecentFiles) and the in-app "Show All…"
 * picker (see dialogs.ts).
 */
import { ipc } from "./ipc";

const STORAGE_KEY = "uninotepad.recentFiles";
const MAX_ENTRIES = 12;

/** Parsed list, newest first. Tolerates missing/corrupt storage. */
export function recentFiles(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Push the current list into the native menu's Open Recent submenu. Called
 *  after every mutation and once at startup (main.ts) so the two views agree. */
export function syncRecentMenu(): void {
  void ipc.setRecentFiles(recentFiles());
}

/** Record a freshly-opened path: move it to the front, de-duplicated, capped. */
export function recordRecent(path: string): void {
  const list = recentFiles().filter((p) => p !== path);
  list.unshift(path);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  syncRecentMenu();
}

export function clearRecent(): void {
  localStorage.removeItem(STORAGE_KEY);
  syncRecentMenu();
}
