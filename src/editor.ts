import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  highlightWhitespace,
  highlightTrailingWhitespace,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  foldGutter,
  codeFolding,
  foldKeymap,
  foldAll as cmFoldAll,
  unfoldAll as cmUnfoldAll,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  gotoLine,
  findNext,
  findPrevious,
  selectNextOccurrence,
} from "@codemirror/search";
import { store, type Tab, type FileTypeId } from "./state";
import { onDocChanged } from "./session";
import { refreshStatusBar } from "./statusbar";
import {
  highlighting,
  effectiveFileType,
  isFastPathType,
  loadFastPathLanguage,
  loadLanguageFor,
} from "./language";
import {
  isWordWrap,
  setWordWrap,
  isShowWhitespace,
  setShowWhitespace,
  showLineNumbers,
  setShowLineNumbers,
  indentUnitString,
  indentWidth,
  editorFontSize,
  setEditorFontSize,
  editorFontFamily,
} from "./settings";
import { updatePreview, schedulePreviewRender } from "./preview";

let view: EditorView;
let hostEl: HTMLElement;

const MIN_FONT = 8;
const MAX_FONT = 40;
const BASE_FONT = 14;

/** The active tab's editor font size, or the global default when no tab is
 *  mounted yet (applyZoom runs at mount, before any tab exists). */
function getActiveFontSize(): number {
  return store.activeTab?.editorFontSize ?? editorFontSize();
}

function clampFont(px: number): number {
  return Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(px)));
}

/** Set the active tab's editor font size (per-tab zoom) and re-apply. A no-op on
 *  the CSS var when there is no active tab (nothing is mounted to zoom). */
function setActiveFontSize(px: number): void {
  const tab = store.activeTab;
  if (tab) tab.editorFontSize = clampFont(px);
  applyZoom();
  refreshStatusBar();
}

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

/** Per-state compartment holding the whitespace-display extension, toggled app-wide. */
const whitespace = new Compartment();

/** Per-state compartment holding the line-number gutter, toggled app-wide.
 *  Only lineNumbers() lives here; foldGutter/highlightActiveLineGutter stay
 *  outside so folding and the active-line marker survive the toggle. */
const gutter = new Compartment();

/** Per-state compartment holding indent unit + tab size, driven by settings. */
const indent = new Compartment();

/** Current wrap extension, driven by the persisted preference. */
function wrapExtension(): Extension {
  return isWordWrap() ? EditorView.lineWrapping : [];
}

/** Current whitespace extension: render spaces/tabs and mark trailing runs when on. */
function whitespaceExtension(): Extension {
  return isShowWhitespace() ? [highlightWhitespace(), highlightTrailingWhitespace()] : [];
}

/** Current gutter extension: the line-number column, driven by the preference. */
function gutterExtension(): Extension {
  return showLineNumbers() ? lineNumbers() : [];
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
  large?: boolean,
): EditorState {
  const head = cursor == null ? 0 : Math.max(0, Math.min(cursor, doc.length));
  // path/fileType are kept in the signature for call-site stability, but the
  // language is resolved lazily by applyLanguage() once the tab is shown.
  void path;
  void fileType;
  // Large-file reduced mode: keep the buffer usable but drop the heavy, per-line
  // features (syntax highlighting, folding, match highlighting). The language
  // compartment stays present but empty so reconfigureLanguage/applyLanguage
  // have something to target while continuing to no-op for large tabs.
  //
  // The compartment always starts empty (even for a recognized type): the
  // grammar is imported dynamically, so applyLanguage() fills it in once the tab
  // is shown. That keeps the language grammars out of the entry chunk.
  return EditorState.create({
    doc,
    selection: { anchor: head },
    extensions: [
      gutter.of(gutterExtension()),
      large ? [] : foldGutter(),
      highlightActiveLineGutter(),
      history(),
      large ? [] : codeFolding(),
      EditorState.allowMultipleSelections.of(true),
      drawSelection(),
      rectangularSelection(),
      highlightActiveLine(),
      large ? [] : highlightSelectionMatches(),
      search({ top: true }),
      closeBrackets(),
      bracketMatching(),
      indentOnInput(),
      indent.of(indentExtension()),
      language.of([]),
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
        ...foldKeymap,
        indentWithTab,
      ]),
      wrap.of(wrapExtension()),
      whitespace.of(whitespaceExtension()),
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
  // Large files stay unhighlighted (the empty language makeState installed): a
  // full re-parse is exactly the cost the reduced mode exists to avoid.
  if (tab.largeFile) return;
  // Normal — whether an explicit pick or a Save As into an unmapped extension —
  // clears highlighting synchronously so the old language doesn't linger during
  // the async resolution below. (For a detected-normal, applyLanguage may still
  // broaden it via the language-data path; an explicit Normal it leaves alone.)
  if (effectiveFileType(tab) === "normal") {
    view.dispatch({ effects: language.reconfigure([]) });
  }
  updatePreview(); // the effective type may have changed the tab's preview status
  void applyLanguage(tab);
}

/**
 * Resolve and install the tab's language into the live view, importing the
 * grammar lazily. Fast-path types (json, python, …) load their dedicated
 * grammar chunk; everything else (unmapped extensions with no explicit pick)
 * falls through to @codemirror/language-data for Notepad++-level coverage.
 * Guarded against the tab switching or being re-typed mid-import, and a no-op
 * when the resolved grammar is already installed (avoids a re-parse on every
 * tab switch).
 */
async function applyLanguage(tab: Tab): Promise<void> {
  // Large files never load a language — reduced mode leaves them unhighlighted.
  if (tab.largeFile) return;
  const ft = effectiveFileType(tab);

  if (isFastPathType(ft)) {
    const ext = await loadFastPathLanguage(ft, tab.path);
    if (!ext) return;
    // The tab may have been switched away from, or re-typed, during the import.
    if (store.state.activeTabId !== tab.id || effectiveFileType(tab) !== ft) return;
    // Same instance already installed → nothing to do (no re-parse on tab switch).
    if (language.get(view.state) === ext) return;
    view.dispatch({ effects: language.reconfigure(ext) });
    return;
  }

  // Non-fast-path (effective "normal"): an explicit pick outranks whatever
  // language-data matches on the filename; without this, switching tabs would
  // silently undo it. The test is fileType, not the effective type: an explicit
  // Normal resolves here but must stay plain, so this blocks language-data too.
  if (tab.fileType !== null) return;
  const path = tab.path;
  if (!path) return;
  const ext = await loadLanguageFor(path);
  if (!ext) return;
  if (store.state.activeTabId !== tab.id || tab.fileType !== null) return;
  if (language.get(view.state) === ext) return;
  view.dispatch({ effects: language.reconfigure(ext) });
}

/** Open CodeMirror's "go to line" panel for the active view. */
export function openGotoLine(): void {
  gotoLine(view);
}

/** Reconfigure one compartment across every tab. The active tab's live doc
 *  lives in the view; the others live in each tab's detached `state`. Shared by
 *  the View-menu toggles and the Preferences modal so a setting written by
 *  either path lands on all open tabs identically. */
function reconfigureAll(compartment: Compartment, ext: Extension): void {
  const activeId = store.state.activeTabId;
  view.dispatch({ effects: compartment.reconfigure(ext) });
  for (const tab of store.state.tabs) {
    if (tab.id === activeId) continue;
    tab.state = tab.state.update({ effects: compartment.reconfigure(ext) }).state;
  }
}

/** Re-apply the current word-wrap preference to every tab. */
export function applyWrap(): void {
  reconfigureAll(wrap, wrapExtension());
}

/** Re-apply the current "show whitespace" preference to every tab. */
export function applyWhitespace(): void {
  reconfigureAll(whitespace, whitespaceExtension());
}

/** Re-apply the current line-number preference to every tab. */
export function applyGutter(): void {
  reconfigureAll(gutter, gutterExtension());
}

/** Re-apply the current indent unit + tab size to every tab. */
export function applyIndent(): void {
  reconfigureAll(indent, indentExtension());
}

/** Flip the app-wide word-wrap preference and reconfigure every tab's state. */
export function toggleWordWrap(): void {
  setWordWrap(!isWordWrap());
  applyWrap();
  refreshStatusBar();
}

/** Flip the app-wide "show whitespace" preference and reconfigure every tab. */
export function toggleShowWhitespace(): void {
  setShowWhitespace(!isShowWhitespace());
  applyWhitespace();
  refreshStatusBar();
}

/** Flip the app-wide line-number preference and reconfigure every tab. */
export function toggleLineNumbers(): void {
  setShowLineNumbers(!showLineNumbers());
  applyGutter();
  refreshStatusBar();
}

/** Add the next occurrence of the current selection/word to the selection
 *  (Cmd/Ctrl+D). Routed from the Edit menu; the key itself is bound by
 *  searchKeymap. */
export function selectNextOccurrenceCmd(): void {
  selectNextOccurrence({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
}

/** Collapse every foldable range in the active view. */
export function foldAll(): void {
  cmFoldAll(view);
}

/** Expand every folded range in the active view. */
export function unfoldAll(): void {
  cmUnfoldAll(view);
}

export function mountEditor(host: HTMLElement): void {
  hostEl = host;
  applyZoom();
  view = new EditorView({ parent: host });
}

/** The built-in fallback stack, kept in sync with styles.css's .cm-scroller
 *  default. A chosen font is prepended to this so unavailable glyphs still fall
 *  through to a working monospace. */
const BASE_FONT_STACK = '"SFMono-Regular", "Consolas", "Menlo", monospace';

function fontFamilyValue(): string {
  const chosen = editorFontFamily();
  return chosen ? `"${chosen}", ${BASE_FONT_STACK}` : BASE_FONT_STACK;
}

/** Push the current font size + family into the CSS variables .cm-scroller
 *  reads. Called by the zoom commands and by Preferences. */
function applyZoom(): void {
  hostEl.style.setProperty("--editor-font-size", `${getActiveFontSize()}px`);
  hostEl.style.setProperty("--editor-font-family", fontFamilyValue());
}

/** Re-apply the current font family (Preferences font picker). */
export function applyFontFamily(): void {
  applyZoom();
}

/** Set an absolute editor font size in px (Preferences number input). This is a
 *  preference, so it updates the global default (the seed for new tabs) *and*
 *  the active tab, so the change is visible immediately. */
export function setEditorFontSizePx(px: number): void {
  const clamped = clampFont(px);
  setEditorFontSize(clamped); // global "new tab default"
  setActiveFontSize(clamped); // reflect on the current tab now
}

export function zoomIn(): void {
  setActiveFontSize(getActiveFontSize() + 1);
}

export function zoomOut(): void {
  setActiveFontSize(getActiveFontSize() - 1);
}

export function zoomReset(): void {
  setActiveFontSize(BASE_FONT);
}

export function getZoomPercent(): number {
  return Math.round((getActiveFontSize() / BASE_FONT) * 100);
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
  applyZoom(); // re-apply this tab's editor font size (per-tab zoom)
  updatePreview(); // show/hide + render for the newly active tab (ratio + preview zoom)
  void applyLanguage(tab); // resolve + install highlighting for the shown tab
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
  const focusReplace = (): boolean => {
    const field = view.dom.querySelector<HTMLInputElement>('input[name="replace"]');
    if (!field) return false;
    field.focus();
    field.select();
    return document.activeElement === field;
  };
  // The replace row usually mounts synchronously with the panel; if focus didn't
  // land (panel not yet in the DOM), retry exactly once on the next frame.
  if (!focusReplace()) requestAnimationFrame(() => void focusReplace());
}

/** Move to the next/previous match. Opens the search panel when no query is set yet. */
export function findNextMatch(): void {
  findNext(view);
}

export function findPrevMatch(): void {
  findPrevious(view);
}
