import { open, save, message } from "@tauri-apps/plugin-dialog";
import { store, newId, type Tab, type EncodingId, type EolId, type FileTypeId } from "./state";
import { ipc } from "./ipc";
import { makeState, showTab, syncTabFromView, reconfigureLanguage } from "./editor";
import { flushNow, dropPending, markBackupDirty, basename } from "./session";
import { recordRecent } from "./recent";
import { applySaveOptions, setPreviewEnabled } from "./settings";
import { openModal, button, type ModalHandle } from "./modal";

function platformEol(): EolId {
  return navigator.userAgent.includes("Windows") ? "crlf" : "lf";
}

// ---- Tab lifecycle ---------------------------------------------------------

/** One past the highest "Untitled N" number among currently-open untitled
 *  tabs (0 → 1 when none are open), so closed numbers are reused. */
function nextUntitledNumber(): number {
  let max = 0;
  for (const t of store.state.tabs) {
    if (t.path !== null) continue;
    const m = /^Untitled (\d+)$/.exec(t.title);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function newUntitled(): void {
  const n = nextUntitledNumber();
  const id = newId();
  const tab: Tab = {
    id,
    path: null,
    title: `Untitled ${n}`,
    dirty: false,
    encoding: "utf8",
    eol: platformEol(),
    fileType: null,
    diskMtimeMs: null,
    missingOnDisk: false,
    state: makeState("", id),
    scrollTop: 0,
    notice: null,
  };
  store.state.tabs.push(tab);
  activateTab(id);
}

/** Open a file in a tab. `fileType` carries a type pick forward (Reopen Closed
 *  Tab); null leaves the tab on extension detection. */
export async function openPath(path: string, fileType: FileTypeId | null = null): Promise<void> {
  const existing = store.state.tabs.find((t) => t.path === path);
  if (existing) {
    recordRecent(path);
    // Only a caller-supplied pick overrides what the open tab already has.
    const override = fileType !== null && existing.fileType !== fileType;
    if (override) existing.fileType = fileType;
    activateTab(existing.id);
    // After activateTab: the pick has to reach the view it just swapped in.
    if (override) reconfigureLanguage(existing);
    return;
  }
  try {
    const opened = await ipc.openFile(path);
    recordRecent(path);
    const id = newId();
    const tab: Tab = {
      id,
      path,
      title: basename(path),
      dirty: false,
      encoding: opened.encoding,
      eol: opened.eol,
      fileType,
      diskMtimeMs: opened.mtimeMs,
      missingOnDisk: false,
      state: makeState(opened.content, id, undefined, path, fileType),
      scrollTop: 0,
      notice: opened.lossy ? lossyNotice() : null,
    };
    store.state.tabs.push(tab);
    activateTab(id);
  } catch (err) {
    await message(`Failed to open ${path}:\n${err}`, { title: "UniNotepad", kind: "error" });
  }
}

/** Notice shown when a file opened/reinterpreted with undecodable bytes. */
function lossyNotice(): { kind: "lossy"; message: string } {
  return {
    kind: "lossy",
    message:
      "Some bytes could not be decoded and were replaced (�). " +
      "Try reinterpreting with a different encoding.",
  };
}

export async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) await openPath(p);
}

export function activateTab(id: string): void {
  const cur = store.activeTab;
  if (cur && cur.id !== id) syncTabFromView(cur);
  store.state.activeTabId = id;
  const t = store.tabById(id);
  if (t) showTab(t);
  store.emit();
  void flushNow();
}

export function activateTabByIndex(index: number): void {
  const tab = store.state.tabs[index];
  if (tab) activateTab(tab.id);
}

export function activateLastTab(): void {
  const tab = store.state.tabs[store.state.tabs.length - 1];
  if (tab) activateTab(tab.id);
}

/** Activate the next (dir=1) or previous (dir=-1) tab, wrapping at both ends. */
export function cycleTab(dir: 1 | -1): void {
  const tabs = store.state.tabs;
  const n = tabs.length;
  if (n === 0) return;
  const i = tabs.findIndex((t) => t.id === store.state.activeTabId);
  const cur = i === -1 ? 0 : i;
  activateTab(tabs[(cur + dir + n) % n].id);
}

export async function openDialog(): Promise<void> {
  const sel = await open({ multiple: true });
  if (!sel) return;
  const paths = Array.isArray(sel) ? sel : [sel];
  await openPaths(paths);
}

async function saveTabAs(tab: Tab): Promise<boolean> {
  const path = await save({ defaultPath: tab.path ?? tab.title });
  if (!path) return false;
  tab.path = path;
  tab.title = basename(path);
  tab.missingOnDisk = false;
  // Re-highlight for the new extension (only the active tab is in the view).
  if (store.state.activeTabId === tab.id) reconfigureLanguage(tab);
  return saveTab(tab);
}

export async function saveTab(tab: Tab, allowLossy = false): Promise<boolean> {
  if (!tab.path) return saveTabAs(tab);
  if (store.activeTab?.id === tab.id) syncTabFromView(tab);
  try {
    const content = applySaveOptions(tab.state.doc.toString());
    const res = await ipc.saveFile(tab.path, content, tab.encoding, tab.eol, allowLossy);
    // Rust wrote nothing because the save would drop characters the encoding
    // can't represent — ask the user how to proceed instead of losing data.
    if (!res.written && res.lossy) {
      const choice = await confirmLossy(tab.encoding);
      if (choice === "cancel") return false;
      if (choice === "utf8") {
        tab.encoding = "utf8";
        return saveTab(tab, false);
      }
      return saveTab(tab, true); // "anyway"
    }
    tab.dirty = false;
    tab.diskMtimeMs = res.mtimeMs;
    tab.missingOnDisk = false;
    tab.notice = null;
    dropPending(tab.id);
    await ipc.deleteBackup(tab.id).catch(() => {});
    store.emit();
    void flushNow();
    return true;
  } catch (err) {
    await message(`Failed to save:\n${err}`, { title: "UniNotepad", kind: "error" });
    return false;
  }
}

export function saveActive(): void {
  const t = store.activeTab;
  if (t) void saveTab(t);
}

export function saveActiveAs(): void {
  const t = store.activeTab;
  if (t) void saveTabAs(t);
}

// ---- Encoding / EOL (status-bar pickers) -----------------------------------

/** Change the active tab's encoding.
 *
 *  Two distinct meanings, chosen by tab state:
 *  - **Clean, file-backed tab → reinterpret.** Re-read the bytes from disk and
 *    re-decode with the picked encoding, replacing the buffer. This is the "fix
 *    a mis-detected file" path (e.g. a garbled Korean EUC-KR file that opened as
 *    Latin-1). We must NOT re-encode the current buffer here: those bytes are
 *    mojibake, and writing them back as EUC-KR would corrupt the file.
 *  - **Dirty or untitled tab → convert.** The disk copy is stale or absent, so
 *    just change the save-target encoding (re-save file-backed, else remember it)
 *    to preserve the unsaved edits. */
export async function setActiveEncoding(enc: EncodingId): Promise<void> {
  const t = store.activeTab;
  if (!t || t.encoding === enc) return;

  if (t.path && !t.dirty) {
    // Reinterpret from disk. Mirrors reloadFromDisk's state swap, but forces
    // the chosen encoding instead of re-detecting.
    try {
      const opened = await ipc.openFileAs(t.path, enc);
      t.encoding = opened.encoding;
      t.diskMtimeMs = opened.mtimeMs;
      t.dirty = false;
      t.state = makeState(opened.content, t.id, undefined, t.path, t.fileType);
      t.notice = opened.lossy ? lossyNotice() : null;
      if (store.state.activeTabId === t.id) showTab(t);
      store.emit();
      void flushNow();
    } catch (err) {
      await message(`Failed to reopen with ${enc}:\n${err}`, {
        title: "UniNotepad",
        kind: "error",
      });
    }
    return;
  }

  // Convert: change the save-target encoding, keeping unsaved edits.
  t.encoding = enc;
  if (t.path) await saveTab(t);
  else store.emit();
}

/** Change the active tab's line ending, with the same save semantics. */
export async function setActiveEol(eol: EolId): Promise<void> {
  const t = store.activeTab;
  if (!t || t.eol === eol) return;
  t.eol = eol;
  if (t.path) await saveTab(t);
  else store.emit();
}

/** Change the active tab's file type. Unlike encoding/EOL this changes no bytes,
 *  so there is nothing to re-save — only the language and the preview. */
export function setActiveFileType(ft: FileTypeId): void {
  const t = store.activeTab;
  if (!t || t.fileType === ft) return;
  t.fileType = ft;
  // An explicit pick beats a stale global toggle; otherwise picking Markdown
  // while the preview is switched off makes the picker look broken.
  if (ft === "markdown" || ft === "mermaid") setPreviewEnabled(true);
  reconfigureLanguage(t); // re-highlights and calls updatePreview()
  store.emit();
  // Untitled tabs never schedule a flush on their own, so persist the pick now.
  void flushNow();
}

// ---- Reopen closed tab -----------------------------------------------------

interface ClosedTab {
  path: string | null;
  title: string;
  doc: string;
  cursor: number;
  encoding: EncodingId;
  eol: EolId;
  fileType: FileTypeId | null;
  scrollTop: number;
  dirty: boolean;
}

const closedStack: ClosedTab[] = [];
const CLOSED_STACK_MAX = 20;

/** Snapshot a tab's content just before it is removed, for Reopen Closed Tab. */
function pushClosed(tab: Tab): void {
  // Ignore pristine, never-touched untitled tabs (nothing worth restoring).
  if (tab.path === null && !tab.dirty && tab.state.doc.length === 0) return;
  closedStack.push({
    path: tab.path,
    title: tab.title,
    doc: tab.state.doc.toString(),
    cursor: tab.state.selection.main.head,
    encoding: tab.encoding,
    eol: tab.eol,
    fileType: tab.fileType,
    scrollTop: tab.scrollTop,
    dirty: tab.dirty,
  });
  if (closedStack.length > CLOSED_STACK_MAX) closedStack.shift();
}

/** Reopen the most recently closed tab (Cmd/Ctrl+Shift+T). */
export async function reopenClosed(): Promise<void> {
  const snap = closedStack.pop();
  if (!snap) return;

  // Clean, file-backed tab: just re-open from disk (single source of truth),
  // carrying the type pick so this shortcut doesn't quietly drop it.
  if (snap.path && !snap.dirty) {
    await openPath(snap.path, snap.fileType);
    return;
  }
  // Already open (e.g. dirty snapshot but file re-opened meanwhile): focus it.
  if (snap.path) {
    const existing = store.state.tabs.find((t) => t.path === snap.path);
    if (existing) {
      activateTab(existing.id);
      return;
    }
  }

  // Restore the buffer (untitled, or unsaved edits) as a fresh tab.
  const id = newId();
  const tab: Tab = {
    id,
    path: snap.path,
    title: snap.title,
    dirty: snap.dirty,
    encoding: snap.encoding,
    eol: snap.eol,
    fileType: snap.fileType,
    diskMtimeMs: null,
    missingOnDisk: false,
    state: makeState(snap.doc, id, snap.cursor, snap.path, snap.fileType),
    scrollTop: snap.scrollTop,
    notice: null,
  };
  store.state.tabs.push(tab);
  if (snap.dirty || snap.path === null) markBackupDirty(id);
  activateTab(id);
}

export function closeActive(): void {
  const t = store.activeTab;
  if (t) void closeTab(t.id);
}

/** Close one tab. Resolves true when the tab was closed, false when the user
 *  cancelled the unsaved-changes prompt or a required save failed — so bulk
 *  callers (closeMany) can stop on the first tab the user declined to close. */
export async function closeTab(id: string): Promise<boolean> {
  const tab = store.tabById(id);
  if (!tab) return false;

  if (tab.dirty) {
    const choice = await confirmClose(tab.title);
    if (choice === "cancel") return false;
    if (choice === "save") {
      const ok = await saveTab(tab);
      if (!ok) return false;
    }
  }

  const idx = store.state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  // Capture the latest buffer (active tab's edits live in the view) before drop.
  if (store.activeTab?.id === id) syncTabFromView(tab);
  pushClosed(tab);
  dropPending(id);
  await ipc.deleteBackup(id).catch(() => {});
  store.state.tabs.splice(idx, 1);

  if (store.state.tabs.length === 0) {
    store.state.activeTabId = null;
    newUntitled(); // always keep at least one tab
    return true;
  }

  if (store.state.activeTabId === id) {
    const next = store.state.tabs[idx] ?? store.state.tabs[idx - 1];
    activateTab(next.id);
  } else {
    store.emit();
    void flushNow();
  }
  return true;
}

/** Close each id in turn, stopping at the first one the user declines to close
 *  (cancelled prompt / failed save). Emptying the tab bar is fine — closeTab's
 *  "always keep one tab" rule re-seeds an untitled tab. */
export async function closeMany(ids: string[]): Promise<void> {
  for (const id of ids) {
    const ok = await closeTab(id);
    if (!ok) break;
  }
}

/** Close every tab except `id` (snapshot first — closeTab mutates the list). */
export function closeOthers(id: string): void {
  const ids = store.state.tabs.filter((t) => t.id !== id).map((t) => t.id);
  void closeMany(ids);
}

/** Close every tab positioned to the right of `id`. */
export function closeTabsToRight(id: string): void {
  const idx = store.state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const ids = store.state.tabs.slice(idx + 1).map((t) => t.id);
  void closeMany(ids);
}

/** Close all tabs (an untitled tab is re-seeded once the last one closes). */
export function closeAll(): void {
  const ids = store.state.tabs.map((t) => t.id);
  void closeMany(ids);
}

/** Save every dirty tab in order, stopping at the first save that fails or is
 *  cancelled (e.g. the Save As dialog dismissed, or a lossy-encoding prompt). */
export async function saveAll(): Promise<void> {
  const dirty = store.state.tabs.filter((t) => t.dirty);
  for (const t of dirty) {
    const ok = await saveTab(t);
    if (!ok) break;
  }
}

/** Move the dragged tab so it sits immediately before `beforeId`. A null
 *  `beforeId` appends it to the end. Direction-independent: the target is a
 *  stable tab id, resolved after the moved tab is spliced out. */
export function reorderTab(fromId: string, beforeId: string | null): void {
  if (fromId === beforeId) return;
  const tabs = store.state.tabs;
  const from = tabs.findIndex((t) => t.id === fromId);
  if (from === -1) return;
  const [moved] = tabs.splice(from, 1);
  let insertAt = beforeId === null ? tabs.length : tabs.findIndex((t) => t.id === beforeId);
  if (insertAt === -1) insertAt = tabs.length;
  tabs.splice(insertAt, 0, moved);
  store.emit();
  void flushNow();
}

// ---- Conflict notice actions ----------------------------------------------

export async function reloadFromDisk(id: string): Promise<void> {
  const tab = store.tabById(id);
  if (!tab || !tab.path) return;
  try {
    const opened = await ipc.openFile(tab.path);
    tab.encoding = opened.encoding;
    tab.eol = opened.eol;
    tab.diskMtimeMs = opened.mtimeMs;
    tab.dirty = false;
    tab.notice = opened.lossy ? lossyNotice() : null;
    tab.missingOnDisk = false;
    // Pass the type pick through: without it the tab keeps fileType while the
    // language compartment reverts to the extension's — picker/editor desync.
    tab.state = makeState(opened.content, tab.id, undefined, tab.path, tab.fileType);
    dropPending(tab.id);
    await ipc.deleteBackup(tab.id).catch(() => {});
    if (store.state.activeTabId === tab.id) showTab(tab);
    store.emit();
    void flushNow();
  } catch (err) {
    await message(`Failed to reload:\n${err}`, { title: "UniNotepad", kind: "error" });
  }
}

/** Clear a tab's notice with no disk-reconciliation side effects (used for the
 *  purely-informational lossy-decode notice). */
export function clearNotice(id: string): void {
  const tab = store.tabById(id);
  if (!tab) return;
  tab.notice = null;
  store.emit();
}

export function dismissNotice(id: string): void {
  const tab = store.tabById(id);
  if (!tab) return;
  // Keep-my-version: keep buffer, keep dirty; just record the current disk mtime
  // so we stop flagging this same divergence.
  tab.notice = null;
  if (tab.path) {
    void ipc.statFile(tab.path).then((st) => {
      tab.diskMtimeMs = st.mtimeMs;
      markBackupDirty(tab.id);
      void flushNow();
    });
  }
  store.emit();
}

// ---- Rendering -------------------------------------------------------------

let tabbarEl: HTMLElement;
let bannerEl: HTMLElement;

export function initTabBar(tabbar: HTMLElement, banner: HTMLElement): void {
  tabbarEl = tabbar;
  bannerEl = banner;
}

// ---- Pointer-based drag-to-reorder -----------------------------------------
// HTML5 draggable is swallowed by Tauri's OS-level drag-drop (needed for
// file-drop-to-open), so reordering uses raw pointer events instead.

interface TabDrag {
  tabId: string;
  startX: number;
  el: HTMLElement;
  active: boolean; // moved past the threshold → a real drag, not a click
}

let tabDrag: TabDrag | null = null;
const DRAG_THRESHOLD_PX = 5;

/** Where the dragged tab would land given the cursor x: the id of the tab to
 *  insert before, or null for the end. Skips the dragged tab itself. */
function dropBeforeId(clientX: number, draggedId: string): string | null {
  for (const child of Array.from(tabbarEl.children) as HTMLElement[]) {
    const id = child.dataset.tabId;
    if (!id || id === draggedId) continue;
    const rect = child.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return id;
  }
  return null;
}

function clearDropIndicators(): void {
  for (const child of Array.from(tabbarEl.children) as HTMLElement[])
    child.classList.remove("drop-before", "drop-after");
}

function showDropIndicator(beforeId: string | null): void {
  clearDropIndicators();
  const children = Array.from(tabbarEl.children) as HTMLElement[];
  if (beforeId === null) children[children.length - 1]?.classList.add("drop-after");
  else children.find((c) => c.dataset.tabId === beforeId)?.classList.add("drop-before");
}

function onTabPointerMove(e: PointerEvent): void {
  if (!tabDrag) return;
  if (!tabDrag.active) {
    if (Math.abs(e.clientX - tabDrag.startX) < DRAG_THRESHOLD_PX) return;
    tabDrag.active = true;
    tabDrag.el.classList.add("dragging");
  }
  showDropIndicator(dropBeforeId(e.clientX, tabDrag.tabId));
}

function endTabDrag(): TabDrag | null {
  document.removeEventListener("pointermove", onTabPointerMove);
  document.removeEventListener("pointerup", onTabPointerUp);
  document.removeEventListener("pointercancel", onTabPointerCancel);
  const d = tabDrag;
  tabDrag = null;
  if (d) {
    d.el.classList.remove("dragging");
    clearDropIndicators();
  }
  return d;
}

function onTabPointerUp(e: PointerEvent): void {
  const d = endTabDrag();
  if (!d) return;
  if (!d.active) {
    activateTab(d.tabId); // never moved → treat as a plain click
    return;
  }
  reorderTab(d.tabId, dropBeforeId(e.clientX, d.tabId));
  activateTab(d.tabId); // keep the just-dropped tab focused
}

// OS/gesture interruption: abandon the drag, leave tab order untouched.
function onTabPointerCancel(): void {
  endTabDrag();
}

export function renderTabBar(): void {
  tabbarEl.replaceChildren();
  for (const tab of store.state.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === store.state.activeTabId ? " active" : "");
    el.dataset.tabId = tab.id;
    el.title = tab.path ?? tab.title;

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = (tab.dirty ? "● " : "") + tab.title;
    el.appendChild(label);

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void closeTab(tab.id);
      }
    });

    // Left-button press starts a potential drag; activation happens on release
    // (pointerup) so a click still selects while a drag reorders. The close
    // button handles its own click, so ignore presses that start on it.
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
      tabDrag = { tabId: tab.id, startX: e.clientX, el, active: false };
      document.addEventListener("pointermove", onTabPointerMove);
      document.addEventListener("pointerup", onTabPointerUp);
      document.addEventListener("pointercancel", onTabPointerCancel);
    });

    tabbarEl.appendChild(el);
  }
  renderBanner();
}

function renderBanner(): void {
  bannerEl.replaceChildren();
  const tab = store.activeTab;
  if (!tab || !tab.notice) {
    bannerEl.style.display = "none";
    return;
  }
  bannerEl.style.display = "flex";
  bannerEl.className = "banner " + tab.notice.kind;

  const msg = document.createElement("span");
  msg.textContent = tab.notice.message;
  bannerEl.appendChild(msg);

  const actions = document.createElement("span");
  actions.className = "banner-actions";

  if (tab.notice.kind === "conflict") {
    actions.appendChild(button("Keep my version", () => dismissNotice(tab.id)));
    actions.appendChild(button("Reload from disk", () => void reloadFromDisk(tab.id)));
  } else if (tab.notice.kind === "deleted") {
    actions.appendChild(button("Save As…", () => void saveTabAs(tab)));
    actions.appendChild(button("Dismiss", () => dismissNotice(tab.id)));
  } else {
    // lossy: nothing to reconcile against disk — just let the user dismiss.
    actions.appendChild(button("Dismiss", () => clearNotice(tab.id)));
  }
  bannerEl.appendChild(actions);
}

// ---- Custom 3-button close confirmation ------------------------------------

type CloseChoice = "save" | "discard" | "cancel";

function confirmClose(title: string): Promise<CloseChoice> {
  return new Promise((resolve) => {
    let handle: ModalHandle;
    const finish = (choice: CloseChoice) => {
      handle.close();
      resolve(choice);
    };
    handle = openModal({ ariaLabel: "Unsaved Changes", onCancel: () => finish("cancel") });

    const text = document.createElement("p");
    text.textContent = `"${title}" has unsaved changes. Save before closing?`;
    handle.box.appendChild(text);

    const row = document.createElement("div");
    row.className = "modal-actions";
    row.appendChild(button("Save", () => finish("save")));
    row.appendChild(button("Don't Save", () => finish("discard")));
    // Cancel is the safe default for a destructive prompt: mark it primary so
    // openModal's initial focus lands here (Enter won't discard by accident).
    const cancel = button("Cancel", () => finish("cancel"));
    cancel.className = "primary";
    row.appendChild(cancel);
    handle.box.appendChild(row);
  });
}

// ---- Lossy-save confirmation -----------------------------------------------

type LossyChoice = "utf8" | "anyway" | "cancel";

/** Friendly names for the encodings that can be lossy on save. */
const LOSSY_ENCODING_NAMES: Partial<Record<EncodingId, string>> = {
  latin1: "Latin-1",
  euckr: "EUC-KR",
  sjis: "Shift-JIS",
  gbk: "GBK",
  big5: "Big5",
};

/** Prompt before a save that would replace unrepresentable characters. Reuses
 *  the confirmClose modal pattern (3 buttons, click-outside cancels). */
function confirmLossy(encoding: EncodingId): Promise<LossyChoice> {
  return new Promise((resolve) => {
    let handle: ModalHandle;
    const finish = (choice: LossyChoice) => {
      handle.close();
      resolve(choice);
    };
    handle = openModal({ ariaLabel: "Encoding Warning", onCancel: () => finish("cancel") });

    const encName = LOSSY_ENCODING_NAMES[encoding] ?? encoding;
    const text = document.createElement("p");
    text.textContent = `Some characters cannot be represented in ${encName} and will be replaced.`;
    handle.box.appendChild(text);

    const row = document.createElement("div");
    row.className = "modal-actions";
    row.appendChild(button("Save as UTF-8", () => finish("utf8")));
    row.appendChild(button("Save Anyway", () => finish("anyway")));
    const cancel = button("Cancel", () => finish("cancel"));
    cancel.className = "primary";
    row.appendChild(cancel);
    handle.box.appendChild(row);
  });
}
