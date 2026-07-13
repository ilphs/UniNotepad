/**
 * Most-recently-opened file paths, persisted in localStorage (theme.ts pattern).
 * Front-end only: the native menu cannot be rebuilt at runtime here, so the list
 * is surfaced through a small in-app picker (see dialogs.ts).
 */

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

/** Record a freshly-opened path: move it to the front, de-duplicated, capped. */
export function recordRecent(path: string): void {
  const list = recentFiles().filter((p) => p !== path);
  list.unshift(path);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
}

export function clearRecent(): void {
  localStorage.removeItem(STORAGE_KEY);
}
