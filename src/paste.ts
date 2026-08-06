/**
 * Paste handling for Markdown tabs: clipboard HTML in, Markdown out.
 *
 * Only Markdown tabs take this path (`Preferences ▸ Editor ▸ Paste HTML as
 * Markdown` turns it off). Everywhere else the default CodeMirror paste runs
 * untouched, so a code or log buffer still receives exactly what the source app
 * put on the clipboard.
 *
 * The conversion is async (Turndown loads on first use), which a DOM paste
 * handler cannot wait for. So the event is cancelled immediately and the text is
 * inserted a tick later — and because the tab may have changed by then, the
 * insert is guarded by the tab id captured at paste time.
 */
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { store } from "./state";
import { effectiveFileType } from "./language";
import { pasteHtmlAsMarkdown } from "./settings";
import { htmlToMarkdown } from "./html-to-markdown";

/** Insert converted Markdown, or the plain flavor if the conversion produced
 *  nothing usable (image-only copy) or failed (a chunk that would not load).
 *  Either way something lands: the paste was already cancelled. */
async function insertConverted(
  view: EditorView,
  tabId: string,
  html: string,
  plain: string,
): Promise<void> {
  let text = plain;
  try {
    text = (await htmlToMarkdown(html)) || plain;
  } catch {
    /* fall back to the plain flavor */
  }
  if (!text) return;
  // The view is shared across tabs (one EditorView, swapped EditorStates), so a
  // tab switch during the await would drop this text into the wrong document.
  if (store.state.activeTabId !== tabId) return;
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

/** The paste interceptor, added once per EditorState in makeState(). */
export function markdownPaste(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const tab = store.activeTab;
      if (!tab || effectiveFileType(tab) !== "markdown") return false;
      if (!pasteHtmlAsMarkdown()) return false;
      const data = event.clipboardData;
      const html = data?.getData("text/html")?.trim();
      if (!html) return false; // plain-text copy — nothing to convert
      const plain = data?.getData("text/plain") ?? "";
      event.preventDefault();
      void insertConverted(view, tab.id, html, plain);
      return true;
    },
  });
}
