/**
 * Window title and app version.
 *
 * The title tracks the active tab (`● notes.md — UniNotepad`) the way editors
 * conventionally do, so the window is identifiable from the Dock / Alt+Tab.
 * The version is fetched once at startup and cached here for the About dialog
 * (dialogs.ts) — it is deliberately no longer part of the title.
 *
 * Only `state.ts` is imported so this stays free of app-module cycles.
 */
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { store } from "./state";

const APP_NAME = "UniNotepad";

let appVersion = "";

/** Cached app version from tauri.conf.json; "" when it could not be read. */
export function version(): string {
  return appVersion;
}

/**
 * Cache the version, then paint the initial title. Best-effort: a failure here
 * must not block editor startup.
 */
export async function initWindowTitle(): Promise<void> {
  try {
    appVersion = await getVersion();
  } catch {
    // Leave the version unknown; the About dialog says so.
  }
  refreshWindowTitle();
}

/** Re-render the window title from the active tab. Safe to call on every store change. */
export function refreshWindowTitle(): void {
  const tab = store.activeTab;
  // Same dirty marker as the tab bar (tabs.ts), plus the app-name suffix.
  const title = tab ? `${tab.dirty ? "● " : ""}${tab.title} — ${APP_NAME}` : APP_NAME;
  void getCurrentWindow().setTitle(title).catch(() => {});
}
