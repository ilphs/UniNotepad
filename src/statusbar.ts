import { store, type EncodingId, type EolId, type FileTypeId } from "./state";
import { getView, getZoomPercent } from "./editor";
import { setActiveEncoding, setActiveEol, setActiveFileType } from "./tabs";
import { effectiveFileType } from "./language";

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

/**
 * Label for every file type, in picker order: Normal/Markdown/Mermaid (the
 * preview-bearing types) first, then alphabetical. A full Record, so a new
 * FileTypeId without a label here is a compile error rather than a type that
 * silently mislabels or goes missing from the picker.
 */
const FILE_TYPE_LABELS: Record<FileTypeId, string> = {
  normal: "Normal",
  markdown: "Markdown",
  mermaid: "Mermaid",
  cpp: "C/C++",
  css: "CSS",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  python: "Python",
  rust: "Rust",
  shell: "Shell",
  sql: "SQL",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

function fileTypeLabel(ft: FileTypeId): string {
  return FILE_TYPE_LABELS[ft];
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
  // Labelled by the effective type, so a .md file reads "Markdown" before any
  // explicit pick is made.
  const ft = effectiveFileType(tab);
  const typeBtn = pickerItem(fileTypeLabel(ft), (a) =>
    openPicker(a, FILETYPE_OPTIONS, ft, (id) => setActiveFileType(id as FileTypeId)),
  );
  const eolBtn = pickerItem(eolLabel(tab.eol), (a) =>
    openPicker(a, EOL_OPTIONS, tab.eol, (id) => void setActiveEol(id as EolId)),
  );
  const encBtn = pickerItem(encLabel(tab.encoding), (a) =>
    openPicker(a, ENC_OPTIONS, tab.encoding, (id) => void setActiveEncoding(id as EncodingId)),
  );
  right.append(zoom, typeBtn, eolBtn, encBtn);

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

// Derived from the label table, so the picker can't drift out of sync with it.
const FILETYPE_OPTIONS: PickerOption[] = Object.entries(FILE_TYPE_LABELS).map(([id, label]) => ({
  id,
  label,
}));

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

  // Position above the anchor (status bar sits at the window bottom). The
  // file-type list can be taller than the space above it, so cap it to that
  // space (it scrolls) instead of letting it run off the top of the viewport.
  const a = anchor.getBoundingClientRect();
  const avail = a.top - 8;
  if (menu.getBoundingClientRect().height > avail) {
    menu.style.maxHeight = `${Math.max(80, avail)}px`;
  }
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, a.right - m.width)}px`;
  menu.style.top = `${Math.max(4, a.top - m.height - 4)}px`;

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
