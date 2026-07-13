import { store, type EncodingId, type EolId } from "./state";
import { getView, getZoomPercent } from "./editor";
import { setActiveEncoding, setActiveEol } from "./tabs";

let el: HTMLElement;

/** Skip whole-document word counting past this size to keep refresh cheap. */
const WORD_LIMIT = 200_000;

export function initStatusBar(host: HTMLElement): void {
  el = host;
}

function eolLabel(eol: string): string {
  return eol === "crlf" ? "CRLF" : "LF";
}

function encLabel(enc: string): string {
  switch (enc) {
    case "utf8bom":
      return "UTF-8-BOM";
    case "latin1":
      return "Latin-1";
    default:
      return "UTF-8";
  }
}

function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

export function refreshStatusBar(): void {
  if (!el) return;
  const tab = store.activeTab;
  if (!tab) {
    el.replaceChildren();
    return;
  }
  const state = getView().state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const col = head - line.from + 1;
  const sel = state.selection.main;

  // Char/word count: selection when there is one, otherwise the whole document.
  let countInfo: string;
  if (!sel.empty) {
    const selLen = sel.to - sel.from;
    countInfo =
      selLen <= WORD_LIMIT
        ? `Sel ${selLen} chars, ${countWords(state.sliceDoc(sel.from, sel.to))} words`
        : `Sel ${selLen} chars`;
  } else {
    const chars = state.doc.length;
    countInfo =
      chars <= WORD_LIMIT
        ? `${chars} chars, ${countWords(state.doc.toString())} words`
        : `${chars} chars`;
  }

  const left = document.createElement("span");
  left.textContent = `Ln ${line.number}, Col ${col} ${countInfo}`;

  const right = document.createElement("span");
  right.className = "status-right";
  const zoom = document.createElement("span");
  zoom.textContent = `${getZoomPercent()}%`;
  const eolBtn = pickerItem(eolLabel(tab.eol), (a) =>
    openPicker(a, EOL_OPTIONS, tab.eol, (id) => void setActiveEol(id as EolId)),
  );
  const encBtn = pickerItem(encLabel(tab.encoding), (a) =>
    openPicker(a, ENC_OPTIONS, tab.encoding, (id) => void setActiveEncoding(id as EncodingId)),
  );
  right.append(zoom, eolBtn, encBtn);

  el.replaceChildren(left, right);
}

// ---- Clickable EOL / encoding pickers --------------------------------------

interface PickerOption {
  id: string;
  label: string;
}

const EOL_OPTIONS: PickerOption[] = [
  { id: "lf", label: "LF (Unix)" },
  { id: "crlf", label: "CRLF (Windows)" },
];

const ENC_OPTIONS: PickerOption[] = [
  { id: "utf8", label: "UTF-8" },
  { id: "utf8bom", label: "UTF-8 with BOM" },
  { id: "latin1", label: "Latin-1 (Windows-1252)" },
];

function pickerItem(label: string, onOpen: (anchor: HTMLElement) => void): HTMLElement {
  const span = document.createElement("span");
  span.className = "status-item";
  span.textContent = label;
  span.title = "Click to change";
  span.addEventListener("click", () => onOpen(span));
  return span;
}

let closeCurrentPicker: (() => void) | null = null;

function openPicker(
  anchor: HTMLElement,
  options: PickerOption[],
  currentId: string,
  onPick: (id: string) => void,
): void {
  closeCurrentPicker?.();

  const menu = document.createElement("div");
  menu.className = "status-menu";
  for (const opt of options) {
    const item = document.createElement("div");
    item.className = "status-menu-item" + (opt.id === currentId ? " selected" : "");
    item.textContent = opt.label;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // fire before the outside-click handler / editor blur
      close();
      onPick(opt.id);
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);

  // Position above the anchor (status bar sits at the window bottom).
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, a.right - m.width)}px`;
  menu.style.top = `${a.top - m.height - 4}px`;

  const onDocDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  function close(): void {
    menu.remove();
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onKey, true);
    closeCurrentPicker = null;
  }
  // Defer so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  closeCurrentPicker = close;
}
