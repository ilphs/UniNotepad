/**
 * In-app updates via tauri-plugin-updater + GitHub Releases (`latest.json`).
 *
 * `check()` runs on every platform (version compare + release notes). Whether an
 * update can be applied *in place* differs by bundle:
 *
 *   - Windows (NSIS/MSI) and Linux AppImage → `downloadAndInstall` + `relaunch`.
 *   - macOS (ad-hoc signed; tauri#12799 makes the .app swap fail) and Linux
 *     `.deb`/`.rpm` → no in-app install, so we fall back to opening the GitHub
 *     releases page for a manual download.
 *
 * The check itself never blocks startup: main.ts fires the first background
 * check a few seconds after the editor is up. A found update surfaces as a
 * status-bar chip; clicking it (or the "Check for Updates…" menu item) opens a
 * modal with the details. "Later" only closes the modal — the chip stays and
 * nothing is persisted, so the prompt returns next launch.
 */
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { openModal } from "./modal";
import { setUpdateBadge, clearUpdateBadge } from "./statusbar";
import { version } from "./title";

/** GitHub releases page — the manual-download fallback target. Scoped in
 *  src-tauri/capabilities/default.json (opener allowlist); keep both in sync. */
const RELEASES_URL = "https://github.com/ilphs/UniNotepad/releases/latest";

/** Guards against overlapping checks (e.g. the startup check racing a manual
 *  one). A second call while one is in flight is ignored. */
let checking = false;

/** The most recent update found, cached so the menu item and the status-bar
 *  chip can reopen the modal without re-running `check()`. */
let pending: Update | null = null;

/** True once an install download has begun — prevents a second one and keeps
 *  the modal from being dismissed mid-flight. */
let installing = false;

/**
 * Whether this build can apply an update in place. Windows always can; macOS
 * never can (ad-hoc signing); Linux only from an AppImage (asked of the
 * backend, which reads the `APPIMAGE` env var).
 */
async function canInstallInApp(): Promise<boolean> {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return true;
  if (ua.includes("Mac")) return false;
  // Linux (or anything else): only AppImage supports in-place install.
  try {
    return await invoke<boolean>("is_appimage");
  } catch {
    return false;
  }
}

/**
 * Check GitHub for a newer release.
 *
 * `interactive` distinguishes a user-triggered check (menu / chip) from the
 * silent startup one: only the interactive path shows "you're up to date" or
 * error dialogs, so a background check can never pop a dialog on its own — it
 * just flips the status-bar chip on when there's something to offer.
 */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  // If we already found one, an interactive re-check just reopens the modal
  // rather than hitting the network again.
  if (pending && interactive) {
    openUpdateModal(pending);
    return;
  }
  if (checking) return;
  checking = true;
  try {
    const update = await check();
    if (update) {
      pending = update;
      setUpdateBadge("⬆ Update available", () => {
        if (pending) openUpdateModal(pending);
      });
      if (interactive) openUpdateModal(update);
    } else {
      clearUpdateBadge();
      if (interactive) showInfoModal("You're up to date", `UniNotepad ${version()} is the latest version.`);
    }
  } catch (err) {
    // Background failures (offline, rate-limited, malformed feed) stay silent;
    // a manual check reports so the user isn't left wondering.
    if (interactive) {
      showInfoModal("Update check failed", `Could not check for updates.\n\n${String(err)}`);
    }
  } finally {
    checking = false;
  }
}

/** A minimal one-message modal with a single "OK" button (up-to-date / error). */
function showInfoModal(title: string, message: string): void {
  const handle = openModal({ ariaLabel: title, onCancel: () => handle.close() });
  const box = handle.box;

  const h = document.createElement("p");
  h.className = "update-title";
  h.textContent = title;
  box.appendChild(h);

  const body = document.createElement("p");
  body.className = "update-message";
  body.textContent = message;
  box.appendChild(body);

  const row = document.createElement("div");
  row.className = "modal-actions";
  const ok = document.createElement("button");
  ok.className = "primary";
  ok.textContent = "OK";
  ok.addEventListener("click", () => handle.close());
  row.appendChild(ok);
  box.appendChild(row);
}

/** The full update modal: version delta, release notes, and platform-specific
 *  primary action (in-app install vs. open download page). */
function openUpdateModal(update: Update): void {
  const handle = openModal({
    ariaLabel: "Update Available",
    onCancel: () => {
      // Don't let Escape/backdrop tear the modal down mid-install: the progress
      // needs its button, and closing wouldn't stop the download anyway.
      if (installing) return;
      handle.close();
    },
  });
  const box = handle.box;
  box.classList.add("update");

  const title = document.createElement("p");
  title.className = "update-title";
  title.textContent = "Update Available";
  box.appendChild(title);

  const versions = document.createElement("p");
  versions.className = "update-versions";
  versions.textContent = `${update.currentVersion}  →  ${update.version}`;
  box.appendChild(versions);

  // Release notes (update.body). Rendered as plain preformatted text — never as
  // HTML — so nothing from the feed can inject markup into the app.
  if (update.body && update.body.trim()) {
    const notes = document.createElement("pre");
    notes.className = "update-notes";
    notes.textContent = update.body.trim();
    box.appendChild(notes);
  }

  const row = document.createElement("div");
  row.className = "modal-actions";

  const later = document.createElement("button");
  later.textContent = "Later";
  later.addEventListener("click", () => {
    if (installing) return;
    handle.close();
  });

  const primary = document.createElement("button");
  primary.className = "primary";
  // Default label assumes the fallback; upgraded to the install button once we
  // know the platform supports in-place install.
  primary.textContent = "Open Download Page";
  primary.addEventListener("click", () => {
    void openUrl(RELEASES_URL).catch(() => {});
    handle.close();
  });

  row.append(later, primary);
  box.appendChild(row);

  // Decide the primary action asynchronously (Linux needs a backend round-trip).
  // Until it resolves the button is the safe "open download page" default.
  void canInstallInApp().then((inApp) => {
    if (!inApp) return; // keep the download-page fallback
    primary.textContent = "Install & Restart";
    // Replace the fallback handler with the in-app install flow.
    const fresh = primary.cloneNode(true) as HTMLButtonElement;
    primary.replaceWith(fresh);
    fresh.addEventListener("click", () => {
      void runInstall(update, fresh, later);
    });
  });
}

/** Download + install the update in place, then relaunch. Reflects progress in
 *  the button label and locks the modal for the duration. */
async function runInstall(
  update: Update,
  installBtn: HTMLButtonElement,
  laterBtn: HTMLButtonElement,
): Promise<void> {
  if (installing) return;
  installing = true;
  installBtn.disabled = true;
  laterBtn.disabled = true;

  let total = 0;
  let received = 0;
  const onEvent = (e: DownloadEvent): void => {
    switch (e.event) {
      case "Started":
        total = e.data.contentLength ?? 0;
        installBtn.textContent = "Downloading… 0%";
        break;
      case "Progress":
        received += e.data.chunkLength;
        installBtn.textContent =
          total > 0
            ? `Downloading… ${Math.min(100, Math.round((received / total) * 100))}%`
            : `Downloading… ${Math.round(received / 1024)} KB`;
        break;
      case "Finished":
        installBtn.textContent = "Installing…";
        break;
    }
  };

  try {
    await update.downloadAndInstall(onEvent);
    // On success most platforms need an explicit relaunch to load the new build.
    installBtn.textContent = "Restarting…";
    await relaunch();
  } catch (err) {
    // Roll back to a retryable state and tell the user.
    installing = false;
    installBtn.disabled = false;
    laterBtn.disabled = false;
    installBtn.textContent = "Install & Restart";
    showInfoModal("Update failed", `The update could not be installed.\n\n${String(err)}`);
  }
}
