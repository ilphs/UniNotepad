/**
 * Frontend side of multi-window. Each window runs this same app with its own
 * tabs; the pieces here are the ones that have to know other windows exist:
 *
 *  - the close flow (last window keeps its tabs for next launch; any other
 *    window discards them, after asking if something is unsaved),
 *  - reporting this window's open files to Rust, so opening a file that is
 *    already open elsewhere switches to that window (tabs.ts → openPath),
 *  - applying preference changes made in another window.
 *
 * Rust counterpart: src-tauri/src/windows.rs (+ forget_window in
 * commands/session.rs).
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { store } from "./state";
import { ipc } from "./ipc";
import { flushNow } from "./session";
import { syncTabFromView, applyWrap, applyWhitespace, applyGutter, applyIndent, applyFontFamily } from "./editor";
import { openModal, button, type ModalHandle } from "./modal";
import { THEME_STORAGE_KEYS, reapplyStoredTheme } from "./theme";
import { refreshPreviewContentWidth } from "./preview";
import {
  WRAP_KEY,
  SHOW_WHITESPACE_KEY,
  SHOW_LINE_NUMBERS_KEY,
  FONT_FAMILY_KEY,
  INDENT_TABS_KEY,
  INDENT_WIDTH_KEY,
  PREVIEW_WIDTH_KEY,
} from "./settings";

// ---- Close -----------------------------------------------------------------

/** Tabs whose content would be lost if this window's session slice went away:
 *  unsaved edits, or an untitled buffer with anything in it. */
function unsavedTabCount(): number {
  const active = store.activeTab;
  if (active) syncTabFromView(active); // the active tab's edits live in the view
  return store.state.tabs.filter((t) => t.dirty || (t.path === null && t.state.doc.length > 0))
    .length;
}

function confirmDiscardWindow(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    let handle: ModalHandle;
    const finish = (discard: boolean) => {
      handle.close();
      resolve(discard);
    };
    handle = openModal({ ariaLabel: "Close Window", onCancel: () => finish(false) });

    const text = document.createElement("p");
    text.textContent =
      count === 1
        ? "1 tab in this window has unsaved changes. Close the window and discard it?"
        : `${count} tabs in this window have unsaved changes. Close the window and discard them?`;
    handle.box.appendChild(text);

    const row = document.createElement("div");
    row.className = "modal-actions";
    row.appendChild(button("Discard and Close", () => finish(true)));
    // Cancel is primary so Enter keeps the tabs (confirmClose's convention).
    const cancel = button("Cancel", () => finish(false));
    cancel.className = "primary";
    row.appendChild(cancel);
    handle.box.appendChild(row);
  });
}

/**
 * Own the window's close request — the title-bar button, File → Close Window
 * and OS-level closes (taskbar, window switcher) all land here. App quit (Cmd+Q / File → Quit) does not: it exits without close
 * requests, so every window's last flushed slice is what the next launch
 * restores.
 *
 *  - Last window: flush and close, as before multi-window — its tabs,
 *    untitled buffers included, come back next launch without a prompt.
 *  - Any other window: its tabs leave the session, so ask first when that
 *    would lose content, then drop its slice (`forgetWindow`) and close.
 *
 * Rust decides "last" (`beginCloseWindow`) because only it sees every window,
 * and it counts windows that are already closing as gone — otherwise two
 * windows closed together could each think the other one stays.
 */
export function initWindowClose(): void {
  const win = getCurrentWindow();
  let closing = false;
  void win.onCloseRequested(async (e) => {
    e.preventDefault();
    if (closing) return; // repeated clicks while the prompt is up
    closing = true;
    try {
      if (await ipc.beginCloseWindow()) {
        await flushNow();
        await win.destroy();
        return;
      }
      const unsaved = unsavedTabCount();
      if (unsaved > 0 && !(await confirmDiscardWindow(unsaved))) {
        await ipc.cancelCloseWindow();
        closing = false;
        return;
      }
      // Release this window's file watches — Rust refcounts them per tab,
      // and a destroyed webview can no longer unwatch.
      for (const t of store.state.tabs) if (t.path) void ipc.unwatchFile(t.path);
      await ipc.forgetWindow();
      await win.destroy();
    } catch (err) {
      // Stay open rather than half-close; the user can retry.
      console.error("window close failed", err);
      closing = false;
      void ipc.cancelCloseWindow().catch(() => {});
    }
  });
}

// ---- Open files registry ---------------------------------------------------

let lastPathsKey: string | null = null;

/** Push this window's file-backed tab paths to Rust when they change. Runs on
 *  every store emit (edits included), so it compares first and only invokes
 *  when the set actually moved. */
function syncOpenPaths(): void {
  const paths = store.state.tabs.map((t) => t.path).filter((p): p is string => p !== null);
  const key = paths.join("\n");
  if (key === lastPathsKey) return;
  lastPathsKey = key;
  void ipc.setOpenPaths(paths);
}

/** Start reporting open files. Call only after the `open-paths` listener is
 *  registered: once a window is listed as holding a file, another window may
 *  send it that file (focus_path_owner) without the readiness queue. */
export function initOpenPathSync(): void {
  store.subscribe(syncOpenPaths);
  syncOpenPaths();
}

// ---- Preferences made in another window ------------------------------------

/** What to re-run when another window writes a preference. Everything in
 *  localStorage is shared by all windows (same origin), but values that are
 *  applied to live editor state have to be re-applied here. Keys absent from
 *  the map are read fresh on use (save options, new-tab seeds, recent files). */
const STORAGE_ACTIONS: Record<string, () => void> = {
  [WRAP_KEY]: applyWrap,
  [SHOW_WHITESPACE_KEY]: applyWhitespace,
  [SHOW_LINE_NUMBERS_KEY]: applyGutter,
  [FONT_FAMILY_KEY]: applyFontFamily,
  [INDENT_TABS_KEY]: applyIndent,
  [INDENT_WIDTH_KEY]: applyIndent,
  [PREVIEW_WIDTH_KEY]: refreshPreviewContentWidth,
  ...Object.fromEntries(THEME_STORAGE_KEYS.map((k) => [k, reapplyStoredTheme])),
};

/** The `storage` event fires only in the *other* same-origin documents, never
 *  in the window that wrote — so this cannot double-apply a local change. */
export function initCrossWindowPrefs(): void {
  window.addEventListener("storage", (e) => {
    if (e.storageArea !== localStorage || e.key === null) return;
    STORAGE_ACTIONS[e.key]?.();
  });
}
