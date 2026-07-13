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

/** Build an overlay whose backdrop-click resolves via `onClose`. */
function overlay(onClose: () => void): { overlay: HTMLElement; box: HTMLElement } {
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal";
  ov.appendChild(box);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) onClose();
  });
  return { overlay: ov, box };
}

// ---- Save options ----------------------------------------------------------

export function openSaveOptions(): void {
  const close = () => document.body.removeChild(ui.overlay);
  const ui = overlay(() => close());

  const title = document.createElement("p");
  title.textContent = "Save Options";
  ui.box.appendChild(title);

  ui.box.appendChild(
    checkboxRow("Trim trailing whitespace on save", trimTrailingOnSave(), setTrimTrailingOnSave),
  );
  ui.box.appendChild(
    checkboxRow("Ensure final newline on save", ensureFinalNewline(), setEnsureFinalNewline),
  );

  const row = document.createElement("div");
  row.className = "modal-actions";
  const done = document.createElement("button");
  done.className = "primary";
  done.textContent = "Done";
  done.addEventListener("click", () => close());
  row.appendChild(done);
  ui.box.appendChild(row);

  document.body.appendChild(ui.overlay);
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
  const close = () => document.body.removeChild(ui.overlay);
  const ui = overlay(() => close());

  const title = document.createElement("p");
  title.textContent = "Recent Files";
  ui.box.appendChild(title);

  const files = recentFiles();
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "No recent files.";
    ui.box.appendChild(empty);
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
        close();
        void openPath(path);
      });
      list.appendChild(item);
    }
    ui.box.appendChild(list);
  }

  const row = document.createElement("div");
  row.className = "modal-actions";
  if (files.length > 0) {
    const clear = document.createElement("button");
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      clearRecent();
      close();
    });
    row.appendChild(clear);
  }
  const cancel = document.createElement("button");
  cancel.className = "primary";
  cancel.textContent = "Close";
  cancel.addEventListener("click", () => close());
  row.appendChild(cancel);
  ui.box.appendChild(row);

  document.body.appendChild(ui.overlay);
}
