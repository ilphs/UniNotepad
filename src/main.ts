import "./styles.css";
import { store } from "./state";
import { ipc, onMenu, onOpenPaths, onFileDrop } from "./ipc";
import { mountEditor, showTab, zoomIn } from "./editor";
import {
  initTabBar,
  renderTabBar,
  newUntitled,
  openPaths,
} from "./tabs";
import { initStatusBar, refreshStatusBar } from "./statusbar";
import { restoreSession, initSessionTriggers } from "./session";
import { handleMenu } from "./menu";
import { applyStoredTheme } from "./theme";
import { mountPreview } from "./preview";
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
  initSessionTriggers();

  // Zoom-in also on Cmd/Ctrl and "+" (Shift+=). The native menu accelerator
  // only covers Cmd/Ctrl+= (one accelerator per menu item), so cover the Shift
  // variant here and stop the WebView's built-in page zoom.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "+") {
      e.preventDefault();
      zoomIn();
    }
  });

  // Tell the backend we are listening so any queued file-opens are delivered.
  await ipc.frontendReady();
}

void bootstrap();
