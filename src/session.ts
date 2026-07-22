import { getCurrentWindow } from "@tauri-apps/api/window";
import { store, FILE_TYPE_IDS, type Tab, type EncodingId, type EolId, type FileTypeId } from "./state";
import { ipc, type SessionManifest, type TabEntry } from "./ipc";
import { makeState, syncTabFromView } from "./editor";
import { previewRatio, editorFontSize } from "./settings";

const DEBOUNCE_MS = 1500;
const SAFETY_INTERVAL_MS = 30_000;
const MANIFEST_VERSION = 1;

/** Tabs whose backup content changed since the last successful flush. */
const pendingBackups = new Set<string>();

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let flushAgain = false;

/** Consecutive persist failures + last error, surfaced via sessionHealth(). */
let persistFailCount = 0;
let lastPersistError: string | null = null;

/** Whether background session persistence is currently failing (and why), for
 *  the status-bar indicator. Only flagged after 2+ consecutive failures so a
 *  single transient blip stays silent. */
export function sessionHealth(): { failing: boolean; error: string | null } {
  return { failing: persistFailCount >= 2, error: lastPersistError };
}

/** A tab needs a backup file iff it is untitled or has unsaved edits. Large
 *  file-backed tabs are excluded: copying tens of MB on every flush is exactly
 *  the cost reduced mode avoids, and the file on disk is the source of truth.
 *  Large *untitled* tabs still get backed up — the buffer is their only copy.
 *  A large file-backed tab whose file vanished from disk (`missingOnDisk`) also
 *  gets backed up: the on-disk source is gone, so the buffer is the only copy
 *  left and dropping it would lose the data on a crash despite its size. */
function needsBackup(t: Tab): boolean {
  if (t.largeFile && t.path !== null && !t.missingOnDisk) return false;
  return t.path === null || t.dirty;
}

/** Called by the editor on a real (user) document change. */
export function onDocChanged(tabId: string): void {
  const tab = store.tabById(tabId);
  if (!tab) return;
  tab.dirty = true;
  tab.notice = null; // a fresh edit supersedes any conflict/deletion notice
  pendingBackups.add(tabId);
  store.emit();
  scheduleFlush();
}

export function scheduleFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushNow();
  }, DEBOUNCE_MS);
}

/** Mark that a tab needs its backup rewritten (e.g. after restore/open). */
export function markBackupDirty(tabId: string): void {
  pendingBackups.add(tabId);
}

/** Remove a tab from the pending-backup set (on save or close). */
export function dropPending(tabId: string): void {
  pendingBackups.delete(tabId);
}

function buildManifest(): SessionManifest {
  const { tabs, activeTabId, nextUntitled } = store.state;
  const entries: TabEntry[] = tabs.map((t) => ({
    id: t.id,
    path: t.path,
    title: t.title,
    dirty: t.dirty,
    hasBackup: needsBackup(t),
    encoding: t.encoding,
    eol: t.eol,
    fileType: t.fileType,
    diskMtimeMs: t.diskMtimeMs,
    largeFile: t.largeFile,
    cursor: t.state.selection.main.head,
    scrollTop: t.scrollTop,
    previewRatio: t.previewRatio,
    editorFontSize: t.editorFontSize,
    previewZoomExp: t.previewZoomExp,
  }));
  return { version: MANIFEST_VERSION, activeTabId, nextUntitled, tabs: entries };
}

/** Flush now: sync live view, write pending backups + manifest atomically. */
export async function flushNow(): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    const active = store.activeTab;
    if (active) syncTabFromView(active);

    const manifest = buildManifest();
    const backups: [string, string][] = [];
    for (const id of pendingBackups) {
      const t = store.tabById(id);
      if (t && needsBackup(t)) backups.push([id, t.state.doc.toString()]);
    }

    const snapshot = new Set(pendingBackups);
    await ipc.persistSession(JSON.stringify(manifest), backups);
    // Only clear ids we actually just wrote (new edits during the await stay).
    for (const id of snapshot) pendingBackups.delete(id);
    // Success: clear any prior failure and drop the indicator if it was shown.
    if (persistFailCount > 0) {
      const wasFailing = persistFailCount >= 2;
      persistFailCount = 0;
      lastPersistError = null;
      if (wasFailing) store.emit();
    }
  } catch (err) {
    console.error("session flush failed", err);
    persistFailCount += 1;
    lastPersistError = String(err);
    // Surface only after a second consecutive failure. pendingBackups is left
    // intact, so the existing 30s safety interval retries automatically — no
    // bespoke retry logic here.
    if (persistFailCount >= 2) store.emit();
  } finally {
    flushing = false;
    if (flushAgain) {
      flushAgain = false;
      void flushNow();
    }
  }
}

// ---- Restore ---------------------------------------------------------------

/** Accept only known ids: the field is absent in older manifests and Rust
 *  round-trips it as a free-form string, so a hand-edited session.json could
 *  otherwise hand CodeMirror a type it throws on. */
function fileTypeFromEntry(v: FileTypeId | null): FileTypeId | null {
  return v != null && FILE_TYPE_IDS.includes(v) ? v : null;
}

function tabFromEntry(entry: TabEntry, doc: string): Tab {
  const encoding: EncodingId = entry.encoding ?? "utf8";
  const eol: EolId = entry.eol ?? "lf";
  // Resolved before makeState: the language is baked into the state it builds,
  // so assigning fileType afterwards would leave the two out of sync.
  const fileType = fileTypeFromEntry(entry.fileType);
  const largeFile = entry.largeFile === true;
  return {
    id: entry.id,
    path: entry.path,
    title: entry.title || (entry.path ? basename(entry.path) : "Untitled"),
    dirty: entry.dirty,
    encoding,
    eol,
    fileType,
    diskMtimeMs: entry.diskMtimeMs,
    missingOnDisk: false,
    largeFile,
    state: makeState(doc, entry.id, entry.cursor ?? undefined, entry.path, fileType, largeFile),
    scrollTop: entry.scrollTop ?? 0,
    // Older manifests lack these — fall back to the current global defaults.
    previewRatio: entry.previewRatio ?? previewRatio(),
    editorFontSize: entry.editorFontSize ?? editorFontSize(),
    previewZoomExp: entry.previewZoomExp ?? 0,
    notice: null,
  };
}

/**
 * Rebuild all tabs from the persisted session, reconciling each file-backed
 * tab against what is currently on disk. Never blocks with a modal; conflicts
 * surface as per-tab notices.
 */
export async function restoreSession(): Promise<void> {
  let loaded;
  try {
    loaded = await ipc.loadSession();
  } catch (err) {
    console.error("load_session failed", err);
    loaded = null;
  }

  if (!loaded || loaded.manifest.tabs.length === 0) {
    return; // caller creates a fresh untitled tab
  }

  store.state.nextUntitled = loaded.manifest.nextUntitled || 1;
  const { backups } = loaded;

  for (const entry of loaded.manifest.tabs) {
    if (entry.path === null) {
      // Untitled: content lives only in the backup.
      const doc = backups[entry.id] ?? "";
      const tab = tabFromEntry(entry, doc);
      tab.dirty = doc.length > 0;
      if (needsBackup(tab)) pendingBackups.add(tab.id);
      store.state.tabs.push(tab);
      continue;
    }

    if (!entry.dirty) {
      // Clean file-backed: re-read from disk (Notepad++ behavior). Carry the
      // tab's prior large-file decision so restore never re-prompts with a modal.
      try {
        const opened = await ipc.openFile(entry.path, entry.largeFile === true);
        // The file grew past the warn threshold since last session (its entry
        // wasn't flagged large, so we didn't pre-approve): don't silently load
        // tens of MB — leave the buffer empty with a dismissible notice.
        if (opened.needsLargeConfirm) {
          const tab = tabFromEntry(entry, "");
          tab.largeFile = true;
          tab.notice = {
            kind: "lossy",
            message:
              `${tab.title} is large and was not reloaded automatically. ` +
              "Reopen it from the File menu to load it.",
          };
          store.state.tabs.push(tab);
          continue;
        }
        const tab = tabFromEntry(entry, opened.content);
        tab.encoding = opened.encoding;
        tab.eol = opened.eol;
        tab.diskMtimeMs = opened.mtimeMs;
        tab.dirty = false;
        tab.largeFile = opened.large;
        store.state.tabs.push(tab);
      } catch {
        const tab = tabFromEntry(entry, "");
        tab.missingOnDisk = true;
        tab.notice = { kind: "deleted", message: "File no longer exists on disk." };
        store.state.tabs.push(tab);
      }
      continue;
    }

    // Dirty file-backed: the backup (user's edits) wins; reconcile vs disk.
    const doc = backups[entry.id] ?? "";
    const tab = tabFromEntry(entry, doc);
    tab.dirty = true;
    pendingBackups.add(tab.id);
    try {
      const st = await ipc.statFile(entry.path);
      if (!st.exists) {
        tab.missingOnDisk = true;
        tab.notice = {
          kind: "deleted",
          message: "Original file was deleted; use Save As to keep your changes.",
        };
      } else if (
        entry.diskMtimeMs != null &&
        st.mtimeMs != null &&
        st.mtimeMs !== entry.diskMtimeMs
      ) {
        tab.notice = {
          kind: "conflict",
          message: `${tab.title} changed on disk after your unsaved edits.`,
        };
      }
    } catch {
      /* stat failed — leave the buffer as-is */
    }
    store.state.tabs.push(tab);
  }

  const first = store.state.tabs[0];
  store.state.activeTabId =
    loaded.manifest.activeTabId &&
    store.state.tabs.some((t) => t.id === loaded!.manifest.activeTabId)
      ? loaded.manifest.activeTabId
      : (first?.id ?? null);
}

// ---- Triggers --------------------------------------------------------------

export function initSessionTriggers(): void {
  window.addEventListener("blur", () => void flushNow());
  setInterval(() => {
    if (pendingBackups.size > 0) void flushNow();
  }, SAFETY_INTERVAL_MS);

  // Final flush on window close, then destroy.
  const win = getCurrentWindow();
  void win.onCloseRequested(async (e) => {
    e.preventDefault();
    await flushNow();
    await win.destroy();
  });
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
