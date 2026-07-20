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
  const banner = document.getElementById("banner")!;
  const editorHost = document.getElementById("editor-host")!;
  const statusbar = document.getElementById("statusbar")!;
  const split = document.getElementById("split")!;
  const previewHost = document.getElementById("preview-host")!;
  const divider = document.getElementById("divider")!;

  initTabBar(tabbar, banner);
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

  // Tell the backend we are listening so any queued file-opens are delivered.
  await ipc.frontendReady();
}

void bootstrap();
