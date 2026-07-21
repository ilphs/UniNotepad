/**
 * Small in-app modal dialogs (reusing the .modal-overlay/.modal CSS from
 * styles.css): the save-options preferences and the recent-files picker.
 * These live in the front-end because the native menu can't be rebuilt at
 * runtime from here.
 */
import {
  trimTrailingOnSave,
  setTrimTrailingOnSave,
  ensureFinalNewline,
  setEnsureFinalNewline,
} from "./settings";
import { recentFiles, clearRecent } from "./recent";
import { openPath } from "./tabs";
import { basename } from "./session";
import { openModal } from "./modal";
import { version } from "./title";
import { openUrl } from "@tauri-apps/plugin-opener";
// Single source of truth: the same icon the bundler ships to the OS.
import appIcon from "../src-tauri/icons/128x128@2x.png";

// ---- About -----------------------------------------------------------------

/** Scoped in src-tauri/capabilities/default.json — keep both in sync. */
const HOMEPAGE = "https://uninotepad-xi.vercel.app";

export function openAbout(): void {
  const handle = openModal({ ariaLabel: "About UniNotepad", onCancel: () => handle.close() });
  const box = handle.box;
  box.classList.add("about");

  const icon = document.createElement("img");
  icon.className = "about-icon";
  icon.src = appIcon;
  icon.alt = ""; // decorative: the app name follows as text
  box.appendChild(icon);

  const name = document.createElement("p");
  name.className = "about-name";
  name.textContent = "UniNotepad";
  box.appendChild(name);

  // Cached at startup by title.ts; empty only if the version lookup failed.
  const v = version();
  const ver = document.createElement("p");
  ver.className = "about-version";
  ver.textContent = v ? `Version ${v}` : "Version unknown";
  box.appendChild(ver);

  const tagline = document.createElement("p");
  tagline.className = "about-tagline";
  tagline.textContent = "Lightweight plain-text editor with tabs and session persistence";
  box.appendChild(tagline);

  const link = document.createElement("p");
  link.className = "about-link";
  const a = document.createElement("a");
  a.href = HOMEPAGE;
  a.textContent = HOMEPAGE.replace(/^https:\/\//, "");
  // The webview must not navigate away from the app: open in the OS browser.
  a.addEventListener("click", (e) => {
    e.preventDefault();
    void openUrl(HOMEPAGE).catch(() => {});
  });
  link.appendChild(a);
  box.appendChild(link);

  const row = document.createElement("div");
  row.className = "modal-actions";
  const close = document.createElement("button");
  close.className = "primary";
  close.textContent = "Close";
  close.addEventListener("click", () => handle.close());
  row.appendChild(close);
  box.appendChild(row);
}

// ---- Save options ----------------------------------------------------------

export function openSaveOptions(): void {
  const handle = openModal({ ariaLabel: "Save Options", onCancel: () => handle.close() });
  const box = handle.box;

  const title = document.createElement("p");
  title.textContent = "Save Options";
  box.appendChild(title);

  box.appendChild(
    checkboxRow("Trim trailing whitespace on save", trimTrailingOnSave(), setTrimTrailingOnSave),
  );
  box.appendChild(
    checkboxRow("Ensure final newline on save", ensureFinalNewline(), setEnsureFinalNewline),
  );

  const row = document.createElement("div");
  row.className = "modal-actions";
  const done = document.createElement("button");
  done.className = "primary";
  done.textContent = "Done";
  done.addEventListener("click", () => handle.close());
  row.appendChild(done);
  box.appendChild(row);
}

function checkboxRow(
  label: string,
  initial: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "checkbox-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = initial;
  cb.addEventListener("change", () => onChange(cb.checked));
  const text = document.createElement("span");
  text.textContent = label;
  wrap.append(cb, text);
  return wrap;
}

// ---- Recent files ----------------------------------------------------------

export function openRecentDialog(): void {
  const handle = openModal({ ariaLabel: "Recent Files", onCancel: () => handle.close() });
  const box = handle.box;

  const title = document.createElement("p");
  title.textContent = "Recent Files";
  box.appendChild(title);

  const files = recentFiles();
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "No recent files.";
    box.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "recent-list";
    for (const path of files) {
      const item = document.createElement("button");
      item.className = "recent-item";
      item.title = path;
      const name = document.createElement("span");
      name.className = "recent-name";
      name.textContent = basename(path);
      const dir = document.createElement("span");
      dir.className = "recent-path";
      dir.textContent = path;
      item.append(name, dir);
      item.addEventListener("click", () => {
        handle.close();
        void openPath(path);
      });
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  const row = document.createElement("div");
  row.className = "modal-actions";
  if (files.length > 0) {
    const clear = document.createElement("button");
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      clearRecent();
      handle.close();
    });
    row.appendChild(clear);
  }
  const cancel = document.createElement("button");
  cancel.className = "primary";
  cancel.textContent = "Close";
  cancel.addEventListener("click", () => handle.close());
  row.appendChild(cancel);
  box.appendChild(row);
}
