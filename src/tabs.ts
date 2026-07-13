import { open, save, message } from "@tauri-apps/plugin-dialog";
import { store, newId, type Tab, type EncodingId, type EolId } from "./state";
import { ipc } from "./ipc";
import { makeState, showTab, syncTabFromView, reconfigureLanguage } from "./editor";
import { flushNow, dropPending, markBackupDirty, basename } from "./session";
import { recordRecent } from "./recent";
import { applySaveOptions } from "./settings";

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
    diskMtimeMs: null,
    missingOnDisk: false,
    state: makeState("", id),
    scrollTop: 0,
    notice: null,
  };
  store.state.tabs.push(tab);
  activateTab(id);
}

export async function openPath(path: string): Promise<void> {
  const existing = store.state.tabs.find((t) => t.path === path);
  if (existing) {
    recordRecent(path);
    activateTab(existing.id);
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
      diskMtimeMs: opened.mtimeMs,
      missingOnDisk: false,
      state: makeState(opened.content, id, undefined, path),
      scrollTop: 0,
      notice: null,
    };
    store.state.tabs.push(tab);
    activateTab(id);
  } catch (err) {
    await message(`Failed to open ${path}:\n${err}`, { title: "UniNotepad", kind: "error" });
  }
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
  if (store.state.activeTabId === tab.id) reconfigureLanguage(tab.path);
  return saveTab(tab);
}

export async function saveTab(tab: Tab): Promise<boolean> {
  if (!tab.path) return saveTabAs(tab);
  if (store.activeTab?.id === tab.id) syncTabFromView(tab);
  try {
    const content = applySaveOptions(tab.state.doc.toString());
    const res = await ipc.saveFile(tab.path, content, tab.encoding, tab.eol);
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

/** Change the active tab's encoding. Re-saves file-backed tabs in the new
 *  encoding immediately; untitled tabs just remember it for the next save. */
export async function setActiveEncoding(enc: EncodingId): Promise<void> {
  const t = store.activeTab;
  if (!t || t.encoding === enc) return;
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

// ---- Reopen closed tab -----------------------------------------------------

interface ClosedTab {
  path: string | null;
  title: string;
  doc: string;
  cursor: number;
  encoding: EncodingId;
  eol: EolId;
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
    scrollTop: tab.scrollTop,
    dirty: tab.dirty,
  });
  if (closedStack.length > CLOSED_STACK_MAX) closedStack.shift();
}

/** Reopen the most recently closed tab (Cmd/Ctrl+Shift+T). */
export async function reopenClosed(): Promise<void> {
  const snap = closedStack.pop();
  if (!snap) return;

  // Clean, file-backed tab: just re-open from disk (single source of truth).
  if (snap.path && !snap.dirty) {
    await openPath(snap.path);
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
    diskMtimeMs: null,
    missingOnDisk: false,
    state: makeState(snap.doc, id, snap.cursor, snap.path),
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

export async function closeTab(id: string): Promise<void> {
  const tab = store.tabById(id);
  if (!tab) return;

  if (tab.dirty) {
    const choice = await confirmClose(tab.title);
    if (choice === "cancel") return;
    if (choice === "save") {
      const ok = await saveTab(tab);
      if (!ok) return;
    }
  }

  const idx = store.state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  // Capture the latest buffer (active tab's edits live in the view) before drop.
  if (store.activeTab?.id === id) syncTabFromView(tab);
  pushClosed(tab);
  dropPending(id);
  await ipc.deleteBackup(id).catch(() => {});
  store.state.tabs.splice(idx, 1);

  if (store.state.tabs.length === 0) {
    store.state.activeTabId = null;
    newUntitled(); // always keep at least one tab
    return;
  }

  if (store.state.activeTabId === id) {
    const next = store.state.tabs[idx] ?? store.state.tabs[idx - 1];
    activateTab(next.id);
  } else {
    store.emit();
    void flushNow();
  }
}

export function reorderTab(fromId: string, toIndex: number): void {
  const tabs = store.state.tabs;
  const from = tabs.findIndex((t) => t.id === fromId);
  if (from === -1) return;
  const [moved] = tabs.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, tabs.length));
  tabs.splice(clamped, 0, moved);
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
    tab.notice = null;
    tab.missingOnDisk = false;
    tab.state = makeState(opened.content, tab.id, undefined, tab.path);
    dropPending(tab.id);
    await ipc.deleteBackup(tab.id).catch(() => {});
    if (store.state.activeTabId === tab.id) showTab(tab);
    store.emit();
    void flushNow();
  } catch (err) {
    await message(`Failed to reload:\n${err}`, { title: "UniNotepad", kind: "error" });
  }
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

export function renderTabBar(): void {
  tabbarEl.replaceChildren();
  for (const tab of store.state.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === store.state.activeTabId ? " active" : "");
    el.draggable = true;
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
    el.addEventListener("click", () => activateTab(tab.id));

    el.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/tab-id", tab.id);
    });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromId = e.dataTransfer?.getData("text/tab-id");
      if (!fromId || fromId === tab.id) return;
      const toIndex = store.state.tabs.findIndex((t) => t.id === tab.id);
      reorderTab(fromId, toIndex);
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
  } else {
    actions.appendChild(button("Save As…", () => void saveTabAs(tab)));
    actions.appendChild(button("Dismiss", () => dismissNotice(tab.id)));
  }
  bannerEl.appendChild(actions);
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

// ---- Custom 3-button close confirmation ------------------------------------

type CloseChoice = "save" | "discard" | "cancel";

function confirmClose(title: string): Promise<CloseChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal";

    const text = document.createElement("p");
    text.textContent = `"${title}" has unsaved changes. Save before closing?`;
    box.appendChild(text);

    const row = document.createElement("div");
    row.className = "modal-actions";

    const finish = (choice: CloseChoice) => {
      document.body.removeChild(overlay);
      resolve(choice);
    };

    row.appendChild(button("Save", () => finish("save")));
    row.appendChild(button("Don't Save", () => finish("discard")));
    const cancel = button("Cancel", () => finish("cancel"));
    cancel.className = "primary";
    row.appendChild(cancel);

    box.appendChild(row);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish("cancel");
    });
    document.body.appendChild(overlay);
  });
}
