import "./styles.css";
import { store } from "./state";
import { ipc, onMenu, onOpenPaths, onFileDrop } from "./ipc";
import { mountEditor, showTab, zoomIn, toggleWordWrap } from "./editor";
import {
  initTabBar,
  renderTabBar,
  newUntitled,
  openPaths,
  cycleTab,
} from "./tabs";
import { initStatusBar, refreshStatusBar } from "./statusbar";
import { restoreSession, initSessionTriggers } from "./session";
import { handleMenu } from "./menu";
import { initContextMenus } from "./contextmenu";
import { isModalOpen } from "./modal";
import { applyStoredTheme } from "./theme";
import { mountPreview } from "./preview";
import { handleZoomShortcut } from "./mermaid-view";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Apply the saved theme before first paint (system mode falls back to CSS).
applyStoredTheme();

// Show the app version in the window title (sourced from tauri.conf.json).
// Best-effort: a failure here must not block editor startup.
getVersion()
  .then((v) => getCurrentWindow().setTitle(`UniNotepad v${v}`))
  .catch(() => {});

async function bootstrap(): Promise<void> {
  const tabbar = document.getElementById("tabbar")!;
  const tabNew = document.getElementById("tab-new")!;
  const banner = document.getElementById("banner")!;
  const editorHost = document.getElementById("editor-host")!;
  const statusbar = document.getElementById("statusbar")!;
  const split = document.getElementById("split")!;
  const previewHost = document.getElementById("preview-host")!;
  const divider = document.getElementById("divider")!;

  initTabBar(tabbar, banner);
  tabNew.addEventListener("click", () => newUntitled());
  initStatusBar(statusbar);
  mountEditor(editorHost);
  // Before any showTab() below (it calls updatePreview()).
  mountPreview(split, editorHost, previewHost, divider);

  // Re-render chrome whenever app state changes.
  store.subscribe(() => {
    renderTabBar();
    refreshStatusBar();
  });

  // Restore the previous session (tabs, dirty buffers, untitled docs).
  await restoreSession();
  if (store.state.tabs.length === 0) {
    newUntitled(); // activates + shows
  } else {
    const active = store.activeTab;
    if (active) showTab(active);
  }
  renderTabBar();
  refreshStatusBar();

  // Wire OS integration.
  await onMenu(handleMenu);
  await onOpenPaths((paths) => void openPaths(paths));
  await onFileDrop((paths) => void openPaths(paths));
  initContextMenus(editorHost, tabbar);
  initSessionTriggers();

  // Zoom-in also on Cmd/Ctrl and "+" (Shift+=). The native menu accelerator
  // only covers Cmd/Ctrl+= (one accelerator per menu item), so cover the Shift
  // variant here and stop the WebView's built-in page zoom. Must run the same
  // chart-vs-editor fork as the menu path (menu.ts), or the two keys for one
  // intent split: over a diagram, Cmd+= would scale the chart while Cmd+Shift+=
  // silently grew the editor font instead.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "+") {
      e.preventDefault();
      if (!handleZoomShortcut(1)) zoomIn();
    }
  });

  // Ctrl+Tab / Ctrl+Shift+Tab cycle through tabs. Bound in the capture phase so
  // it wins before CodeMirror or the WebView can act on Tab; the native menu
  // registers no accelerator for these on purpose, so there's no double-fire.
  window.addEventListener(
    "keydown",
    (e) => {
      // Stand down while a modal is up: switching the tab under a dirty-close
      // or lossy-save prompt would change what the prompt applies to.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab" && !isModalOpen()) {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      }
    },
    true,
  );

  // macOS: Alt+Z (Option+Z) toggles word wrap. The native menu can't own this
  // accelerator on macOS because Option+Z produces "Ω" as e.key, so match on
  // e.code instead. Guarded to macOS so it can't double-fire against the Alt+Z
  // menu accelerator the other platforms register.
  const isMac = navigator.userAgent.includes("Mac");
  if (isMac) {
    window.addEventListener("keydown", (e) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyZ") {
        e.preventDefault();
        toggleWordWrap();
      }
    });
  }

  // Windows: native menu accelerators never fire while the WebView has focus.
  // WebView2 pumps keyboard input inside its own child HWND/thread, so the
  // host message loop — where Tauri's msg_hook would run TranslateAcceleratorW
  // against the menu's HACCEL table — never sees the WM_KEYDOWN. The editor
  // effectively always has focus, so every accelerator-only shortcut silently
  // no-ops there. Replay the menu's accelerator table from the webview
  // instead: keydown → handleMenu(id), the same dispatch a real menu click
  // takes. Gated to Windows — on macOS/Linux native accelerators do fire and
  // this would double-trigger. Bound in the bubble phase and skipping
  // defaultPrevented events so CodeMirror keeps priority for the keys it owns
  // (Ctrl+Z/F/G, F3, …) while the same combos still work when focus is
  // outside the editor.
  const isWindows = navigator.userAgent.includes("Windows");
  if (isWindows) {
    // Mirror of the accelerators in src-tauri/src/menu.rs (Windows spellings).
    // Key format: mods + "+" + e.key.toLowerCase(), mods being "C"=Ctrl,
    // "S"=Shift, "A"=Alt in that fixed order. Ctrl+Tab and Ctrl+"+" (the
    // shifted zoom-in) stay with their dedicated listeners above.
    const accelTable: Record<string, string> = {
      "C+n": "file.new",
      "C+o": "file.open",
      "C+s": "file.save",
      "CS+s": "file.saveAs",
      "CA+s": "file.saveAll",
      "C+p": "file.print",
      "CS+t": "file.reopenClosed",
      "C+w": "file.close",
      "C+z": "edit.undo",
      "CS+z": "edit.redo",
      "C+f": "edit.find",
      "+f3": "edit.findNext",
      "S+f3": "edit.findPrev",
      "C+h": "edit.replace",
      "C+=": "view.zoomIn",
      "C+-": "view.zoomOut",
      "C+0": "view.zoomReset",
      "C+g": "view.gotoLine",
      "A+z": "view.toggleWrap",
      "CS+m": "view.togglePreview",
      "C+1": "view.gotoTab1",
      "C+2": "view.gotoTab2",
      "C+3": "view.gotoTab3",
      "C+4": "view.gotoTab4",
      "C+5": "view.gotoTab5",
      "C+6": "view.gotoTab6",
      "C+7": "view.gotoTab7",
      "C+8": "view.gotoTab8",
      "C+9": "view.gotoTab9",
    };
    window.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) return; // CodeMirror (or another handler) took it
      if (e.metaKey) return;
      // Same stand-down as Ctrl+Tab: acting under a dirty-close or lossy-save
      // prompt would change what the prompt applies to.
      if (isModalOpen()) return;
      const mods =
        (e.ctrlKey ? "C" : "") + (e.shiftKey ? "S" : "") + (e.altKey ? "A" : "");
      const id = accelTable[`${mods}+${e.key.toLowerCase()}`];
      if (!id) return;
      e.preventDefault();
      handleMenu(id);
    });
  }

  // Tell the backend we are listening so any queued file-opens are delivered.
  await ipc.frontendReady();
}

void bootstrap();
