import "./styles.css";
import { store } from "./state";
import { ipc, onMenu, onOpenPaths } from "./ipc";
import { mountEditor, showTab } from "./editor";
import {
  initTabBar,
  renderTabBar,
  newUntitled,
  openPaths,
} from "./tabs";
import { initStatusBar, refreshStatusBar } from "./statusbar";
import { restoreSession, initSessionTriggers } from "./session";
import { handleMenu } from "./menu";

async function bootstrap(): Promise<void> {
  const tabbar = document.getElementById("tabbar")!;
  const banner = document.getElementById("banner")!;
  const editorHost = document.getElementById("editor-host")!;
  const statusbar = document.getElementById("statusbar")!;

  initTabBar(tabbar, banner);
  initStatusBar(statusbar);
  mountEditor(editorHost);

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
  initSessionTriggers();

  // Tell the backend we are listening so any queued file-opens are delivered.
  await ipc.frontendReady();
}

void bootstrap();
