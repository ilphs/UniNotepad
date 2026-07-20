/**
 * Native right-click context menus (Tauri Menu API) for the editor surface and
 * the tab bar. Built fresh on each invocation and popped at the cursor.
 *
 * Editor menu: custom Undo/Redo routed through CodeMirror's history, plus the
 * predefined clipboard items so the OS handles Cut/Copy/Paste/Select All
 * natively against the focused WebView (same split as the native menu bar).
 */
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { doUndo, doRedo } from "./editor";
import { store } from "./state";
import { closeTab, closeOthers, closeTabsToRight, closeAll, saveAll } from "./tabs";

// Menus are Rust-side resources that live until explicitly closed; keep the
// previous popup around (its action may still be dispatching) and free it when
// the next one opens, so repeated right-clicks never accumulate resources.
let lastMenu: Menu | null = null;

async function popup(menu: Menu): Promise<void> {
  if (lastMenu) void lastMenu.close().catch(() => {});
  lastMenu = menu;
  await menu.popup();
}

export async function showEditorContextMenu(): Promise<void> {
  const undo = await MenuItem.new({ text: "Undo", action: () => doUndo() });
  const redo = await MenuItem.new({ text: "Redo", action: () => doRedo() });
  const sep = await PredefinedMenuItem.new({ item: "Separator" });
  const cut = await PredefinedMenuItem.new({ item: "Cut" });
  const copy = await PredefinedMenuItem.new({ item: "Copy" });
  const paste = await PredefinedMenuItem.new({ item: "Paste" });
  const selectAll = await PredefinedMenuItem.new({ item: "SelectAll" });
  const menu = await Menu.new({ items: [undo, redo, sep, cut, copy, paste, selectAll] });
  await popup(menu);
}

/**
 * Tab context menu. Acts on the clicked tab id (captured by the caller), which
 * may not be the active tab, so every action is id-based. "Close Others" is
 * disabled when there is only one tab; "Close Tabs to the Right" is disabled
 * when the clicked tab is already the rightmost.
 */
export async function showTabContextMenu(tabId: string): Promise<void> {
  const tabs = store.state.tabs;
  const idx = tabs.findIndex((t) => t.id === tabId);
  const onlyOne = tabs.length <= 1;
  const hasRight = idx !== -1 && idx < tabs.length - 1;

  const close = await MenuItem.new({ text: "Close", action: () => void closeTab(tabId) });
  const closeOthersItem = await MenuItem.new({
    text: "Close Others",
    enabled: !onlyOne,
    action: () => closeOthers(tabId),
  });
  const closeRight = await MenuItem.new({
    text: "Close Tabs to the Right",
    enabled: hasRight,
    action: () => closeTabsToRight(tabId),
  });
  const closeAllItem = await MenuItem.new({ text: "Close All", action: () => closeAll() });
  const sep = await PredefinedMenuItem.new({ item: "Separator" });
  const saveAllItem = await MenuItem.new({ text: "Save All", action: () => void saveAll() });

  const menu = await Menu.new({
    items: [close, closeOthersItem, closeRight, closeAllItem, sep, saveAllItem],
  });
  await popup(menu);
}

/** Attach contextmenu handlers to the editor host and the tab bar. Tab clicks
 *  are delegated: the nearest [data-tab-id] ancestor identifies the tab, and a
 *  right-click on empty tab-bar space is ignored. */
export function initContextMenus(editorHost: HTMLElement, tabbar: HTMLElement): void {
  editorHost.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void showEditorContextMenu();
  });
  tabbar.addEventListener("contextmenu", (e) => {
    const tabEl = (e.target as HTMLElement).closest<HTMLElement>("[data-tab-id]");
    if (!tabEl) return; // empty tab-bar space
    e.preventDefault();
    const id = tabEl.dataset.tabId;
    if (id) void showTabContextMenu(id);
  });
}
