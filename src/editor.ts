import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  gotoLine,
  findNext,
  findPrevious,
} from "@codemirror/search";
import { store, type Tab, type FileTypeId } from "./state";
import { onDocChanged } from "./session";
import { refreshStatusBar } from "./statusbar";
import {
  highlighting,
  languageForPath,
  languageForFileType,
  detectFileType,
  effectiveFileType,
  loadLanguageFor,
} from "./language";
import {
  isWordWrap,
  setWordWrap,
  indentUnitString,
  indentWidth,
} from "./settings";
import { updatePreview, schedulePreviewRender } from "./preview";

let view: EditorView;
let hostEl: HTMLElement;

const MIN_FONT = 8;
const MAX_FONT = 40;
const BASE_FONT = 14;
let fontSize = BASE_FONT;

/**
 * Build a fresh EditorState for one tab. The updateListener closes over this
 * tab's id so edits route to the correct tab regardless of which state is
 * currently mounted in the single shared view.
 */
/** Per-state compartment holding the language, so it can be reconfigured
 *  (e.g. after Save As changes the file extension) without losing history. */
const language = new Compartment();

/** Per-state compartment holding the line-wrap extension, toggled app-wide. */
const wrap = new Compartment();

/** Per-state compartment holding indent unit + tab size, driven by settings. */
const indent = new Compartment();

/** Current wrap extension, driven by the persisted preference. */
function wrapExtension(): Extension {
  return isWordWrap() ? EditorView.lineWrapping : [];
}

/** Current indent extension: the per-level string plus the Tab display width. */
function indentExtension(): Extension {
  return [indentUnit.of(indentUnitString()), EditorState.tabSize.of(indentWidth())];
}

export function makeState(
  doc: string,
  tabId: string,
  cursor?: number,
  path?: string | null,
  fileType?: FileTypeId | null,
): EditorState {
  const head = cursor == null ? 0 : Math.max(0, Math.min(cursor, doc.length));
  const p = path ?? null;
  const ft = fileType ?? detectFileType(p);
  return EditorState.create({
    doc,
    selection: { anchor: head },
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      closeBrackets(),
      bracketMatching(),
      indentOnInput(),
      indent.of(indentExtension()),
      language.of(languageForFileType(ft, p)),
      highlighting,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        // Go to Line on Ctrl+G everywhere (Control+G on macOS, as in VS Code);
        // macOS keeps Cmd+G as Find Next. On Windows/Linux this normalizes to
        // the same key as searchKeymap's Mod-g (findNext), so it has to stay
        // ahead of it: same-key bindings merge into one run array, and the
        // first command returning true wins.
        { key: "Mod-g", mac: "Ctrl-g", run: gotoLine },
        ...searchKeymap,
        indentWithTab,
      ]),
      wrap.of(wrapExtension()),
      EditorView.updateListener.of((u) => {
        // Ignore programmatic setState (tab switch): those carry no transactions.
        if (u.docChanged && u.transactions.length > 0) {
          onDocChanged(tabId);
          schedulePreviewRender();
        }
        if (u.selectionSet || u.docChanged || u.transactions.length === 0) {
          refreshStatusBar();
        }
      }),
    ],
  });
}

/** Re-apply the active tab's language (used after Save As changes the extension,
 *  and after the type picker changes the tab's type). Takes the tab, not a path:
 *  a path alone would discard an explicit pick. */
export function reconfigureLanguage(tab: Tab): void {
  const ext = languageForFileType(effectiveFileType(tab), tab.path);
  view.dispatch({ effects: language.reconfigure(ext) });
  updatePreview(); // the effective type may have changed the tab's preview status
  void applyLazyLanguage(tab);
}

/**
 * For extensions the static fast-path doesn't cover, lazily resolve a language
 * via @codemirror/language-data and reconfigure the live view once it loads.
 * No-op when the fast-path already handled the file (avoids a re-highlight
 * flash for common languages). Guarded against the tab switching mid-load.
 */
async function applyLazyLanguage(tab: Tab): Promise<void> {
  // An explicit pick outranks whatever language-data matches on the filename;
  // without this, switching tabs would silently undo it (e.g. CMakeLists.txt
  // set to Markdown). The test is fileType, not the effective type: an explicit
  // Normal resolves to no language, which would let language-data back in.
  if (tab.fileType !== null) return;
  const path = tab.path;
  if (!path) return;
  const staticExt = languageForPath(path);
  // Fast-path already resolved a language → nothing to lazy-load.
  if (!Array.isArray(staticExt) || staticExt.length > 0) return;
  const ext = await loadLanguageFor(path);
  if (!ext) return;
  // The tab may have been switched away from, or given an explicit type, during
  // the async import.
  if (store.state.activeTabId !== tab.id || tab.fileType !== null) return;
  view.dispatch({ effects: language.reconfigure(ext) });
}

/** Open CodeMirror's "go to line" panel for the active view. */
export function openGotoLine(): void {
  gotoLine(view);
}

/** Flip the app-wide word-wrap preference and reconfigure every tab's state. */
export function toggleWordWrap(): void {
  setWordWrap(!isWordWrap());
  const ext = wrapExtension();
  const activeId = store.state.activeTabId;
  // The active tab's live doc lives in the view; others live in tab.state.
  view.dispatch({ effects: wrap.reconfigure(ext) });
  for (const tab of store.state.tabs) {
    if (tab.id === activeId) continue;
    tab.state = tab.state.update({ effects: wrap.reconfigure(ext) }).state;
  }
  refreshStatusBar();
}

export function mountEditor(host: HTMLElement): void {
  hostEl = host;
  applyZoom();
  view = new EditorView({ parent: host });
}

function applyZoom(): void {
  hostEl.style.setProperty("--editor-font-size", `${fontSize}px`);
}

export function zoomIn(): void {
  fontSize = Math.min(MAX_FONT, fontSize + 1);
  applyZoom();
  refreshStatusBar();
}

export function zoomOut(): void {
  fontSize = Math.max(MIN_FONT, fontSize - 1);
  applyZoom();
  refreshStatusBar();
}

export function zoomReset(): void {
  fontSize = BASE_FONT;
  applyZoom();
  refreshStatusBar();
}

export function getZoomPercent(): number {
  return Math.round((fontSize / BASE_FONT) * 100);
}

export function getView(): EditorView {
  return view;
}

/** Swap the given tab's state into the view and restore its scroll position. */
export function showTab(tab: Tab): void {
  view.setState(tab.state);
  view.focus();
  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = tab.scrollTop;
  });
  updatePreview(); // show/hide + render for the newly active tab
  void applyLazyLanguage(tab); // broaden highlighting for long-tail extensions
}

/** Persist the live view (doc, selection, undo history, scroll) back into a tab. */
export function syncTabFromView(tab: Tab): void {
  tab.state = view.state;
  tab.scrollTop = view.scrollDOM.scrollTop;
}

export function currentDoc(): string {
  return view.state.doc.toString();
}

export function doUndo(): void {
  undo(view);
}

export function doRedo(): void {
  redo(view);
}

export function openFind(): void {
  openSearchPanel(view);
}

/**
 * Open the search panel with the replace field focused. The panel mounts
 * synchronously during openSearchPanel's dispatch and focuses the search
 * field, so moving focus afterwards wins. The replace row is only rendered
 * for a writable document; focus stays on the search field otherwise.
 */
export function openReplace(): void {
  openSearchPanel(view);
  // Scoped to input: the "replace" button carries the same name attribute.
  const field = view.dom.querySelector<HTMLInputElement>('input[name="replace"]');
  if (!field) return;
  field.focus();
  field.select();
}

/** Move to the next/previous match. Opens the search panel when no query is set yet. */
export function findNextMatch(): void {
  findNext(view);
}

export function findPrevMatch(): void {
  findPrevious(view);
}
