import { store, type EncodingId, type EolId, type FileTypeId } from "./state";
import { getView, getZoomPercent } from "./editor";
import {
  getPreviewZoomPercent,
  isPreviewVisible,
  isPreviewCapable,
  isEditorPaneVisible,
  togglePreview,
  toggleEditorPane,
} from "./preview";
import { setActiveEncoding, setActiveEol, setActiveFileType } from "./tabs";
import { effectiveFileType } from "./language";
import { sessionHealth, flushNow } from "./session";

let el: HTMLElement;

/** Skip whole-document word counting past this size to keep refresh cheap. */
const WORD_LIMIT = 200_000;

export function initStatusBar(host: HTMLElement): void {
  el = host;
}

// ---- Update badge ----------------------------------------------------------
// A persistent "Update available" chip in the status bar's right group. The bar
// is fully rebuilt on every store change (refreshStatusBar → replaceChildren),
// so the badge can't be a stray DOM node — its state lives here and each refresh
// re-renders it. updater.ts owns the semantics and toggles via this small API,
// keeping the two modules decoupled (no import cycle).
let updateBadgeLabel: string | null = null;
let updateBadgeOnClick: (() => void) | null = null;

/** Show (or update) the status-bar update chip; clicking it runs `onClick`. */
export function setUpdateBadge(label: string, onClick: () => void): void {
  updateBadgeLabel = label;
  updateBadgeOnClick = onClick;
  refreshStatusBar();
}

/** Remove the status-bar update chip. */
export function clearUpdateBadge(): void {
  updateBadgeLabel = null;
  updateBadgeOnClick = null;
  refreshStatusBar();
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
    case "euckr":
      return "EUC-KR";
    case "sjis":
      return "Shift-JIS";
    case "gbk":
      return "GBK";
    case "big5":
      return "Big5";
    case "utf16le":
      return "UTF-16 LE";
    case "utf16be":
      return "UTF-16 BE";
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
  // With multiple cursors, a single Ln/Col is meaningless — show the count instead.
  const ranges = state.selection.ranges.length;
  left.textContent =
    ranges > 1
      ? `${ranges} selections ${countInfo}`
      : `Ln ${line.number}, Col ${col} ${countInfo}`;

  const right = document.createElement("span");
  right.className = "status-right";
  // Editor + preview chips: zoom readout while the pane is open, "off" while it
  // is closed. Labelled so the two independent scales are unambiguous, and
  // clickable so a pane closed with its × has a way back — the × itself is gone
  // once the pane is hidden.
  const editorZoom = paneChip(
    isEditorPaneVisible() ? `Editor ${getZoomPercent()}%` : "Editor off",
    isEditorPaneVisible(),
    // Only meaningful while the preview is up: that is both what the editor
    // falls back to when closed, and the only state it can be closed from.
    isPreviewVisible() ? toggleEditorPane : null,
  );
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
  right.append(editorZoom);
  // Gated on "can this tab preview at all", not "is it showing": a closed pane
  // still needs its chip, or there would be no way to bring it back.
  if (isPreviewCapable()) {
    const shown = isPreviewVisible();
    right.append(
      paneChip(shown ? `Preview ${getPreviewZoomPercent()}%` : "Preview off", shown, togglePreview),
    );
  }
  right.append(typeBtn, eolBtn, encBtn);

  // Backup-persistence failure indicator (leads the right group so it stands
  // out). Clicking it retries the flush immediately.
  const health = sessionHealth();
  if (health.failing) {
    const warn = document.createElement("span");
    warn.className = "status-item";
    warn.textContent = "⚠ Backup save failed";
    warn.title = health.error ?? "Session backup could not be written. Click to retry.";
    onPress(warn, () => void flushNow());
    right.prepend(warn);
  }

  // "Update available" chip, when updater.ts has flagged one. Leads the right
  // group (before the backup warning) so it is the first thing seen; clicking
  // opens the update modal.
  if (updateBadgeLabel) {
    const badge = document.createElement("span");
    badge.className = "status-item update-badge";
    badge.textContent = updateBadgeLabel;
    badge.title = "Click for details";
    const onClick = updateBadgeOnClick;
    onPress(badge, () => onClick?.());
    right.prepend(badge);
  }

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
  { id: "euckr", label: "EUC-KR (한국어)" },
  { id: "sjis", label: "Shift-JIS (日本語)" },
  { id: "gbk", label: "GBK (简体中文)" },
  { id: "big5", label: "Big5 (繁體中文)" },
  { id: "utf16le", label: "UTF-16 LE" },
  { id: "utf16be", label: "UTF-16 BE" },
];

// Derived from the label table, so the picker can't drift out of sync with it.
const FILETYPE_OPTIONS: PickerOption[] = Object.entries(FILE_TYPE_LABELS).map(([id, label]) => ({
  id,
  label,
}));

/**
 * Wire a status-bar chip to fire on mousedown, not click.
 *
 * `click` is unusable here: pressing a chip blurs the editor, CodeMirror
 * reports that focus change ~10ms later as an empty update, and our update
 * listener rebuilds the whole bar (replaceChildren) — so by mouseup the pressed
 * span is detached and no click ever reaches it. The first press on any chip
 * would be swallowed. preventDefault also keeps focus in the editor, so the
 * rebuild never happens in the first place.
 */
function onPress(span: HTMLElement, handler: () => void): void {
  span.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handler();
  });
}

/** A pane chip: zoom readout when the pane is open, dimmed "off" when closed.
 *  `onToggle` null means the chip is inert — the pane is the only one left, so
 *  closing it would leave an empty window. */
function paneChip(label: string, shown: boolean, onToggle: (() => void) | null): HTMLElement {
  const span = document.createElement("span");
  span.textContent = label;
  if (!shown) span.classList.add("pane-off");
  if (onToggle) {
    span.classList.add("status-item");
    span.title = shown ? "Click to close this pane" : "Click to reopen this pane";
    onPress(span, onToggle);
  }
  return span;
}

function pickerItem(label: string, onOpen: (anchor: HTMLElement) => void): HTMLElement {
  const span = document.createElement("span");
  span.className = "status-item";
  span.textContent = label;
  span.title = "Click to change";
  onPress(span, () => {
    // Pressing the chip that owns the open menu dismisses it (openPicker leaves
    // presses on its own anchor to us rather than closing as an outside click).
    if (currentPickerAnchor === span) {
      closeCurrentPicker?.();
      return;
    }
    onOpen(span);
  });
  return span;
}

let closeCurrentPicker: (() => void) | null = null;
let currentPickerAnchor: HTMLElement | null = null;

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
    const target = e.target as Node;
    // The anchor is excluded so pressing it toggles (pickerItem) instead of
    // closing here and immediately reopening.
    if (!menu.contains(target) && !anchor.contains(target)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  function close(): void {
    menu.remove();
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onKey, true);
    closeCurrentPicker = null;
    currentPickerAnchor = null;
  }
  // Defer so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  closeCurrentPicker = close;
  currentPickerAnchor = anchor;
}
