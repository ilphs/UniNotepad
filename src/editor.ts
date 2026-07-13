import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo, redo } from "@codemirror/commands";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from "@codemirror/search";
import type { Tab } from "./state";
import { onDocChanged } from "./session";
import { refreshStatusBar } from "./statusbar";
import { highlighting, languageForPath } from "./language";

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
      language.of(languageForPath(path ?? null)),
      highlighting,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        // Ignore programmatic setState (tab switch): those carry no transactions.
        if (u.docChanged && u.transactions.length > 0) {
          onDocChanged(tabId);
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
