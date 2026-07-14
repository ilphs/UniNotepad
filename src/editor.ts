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
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  gotoLine,
} from "@codemirror/search";
import { store, type Tab } from "./state";
import { onDocChanged } from "./session";
import { refreshStatusBar } from "./statusbar";
import { highlighting, languageForPath } from "./language";
import { isWordWrap, setWordWrap } from "./settings";
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

/** Current wrap extension, driven by the persisted preference. */
function wrapExtension(): Extension {
  return isWordWrap() ? EditorView.lineWrapping : [];
}

export function makeState(
  doc: string,
  tabId: string,
  cursor?: number,
  path?: string | null,
): EditorState {
  const head = cursor == null ? 0 : Math.max(0, Math.min(cursor, doc.length));
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
      language.of(languageForPath(path ?? null)),
      highlighting,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
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

/** Re-apply the language for the active tab's path (used after Save As). */
export function reconfigureLanguage(path: string | null): void {
  view.dispatch({ effects: language.reconfigure(languageForPath(path)) });
  updatePreview(); // extension may have changed the file's Markdown status
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
