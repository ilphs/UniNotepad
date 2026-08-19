/**
 * Markdown preview pane. Renders the active tab in a right-hand pane split from
 * the editor by a draggable divider: Markdown → sanitized HTML injected into a
 * `.md-body` div, with ```mermaid fenced blocks rendered as diagrams. A
 * standalone `.mmd`/`.mermaid` file is rendered whole as a single diagram.
 *
 * The pane shows when the active tab's effective type is Markdown or Mermaid —
 * from its extension, or from an explicit pick in the status bar — AND that
 * tab's preview pane is open. Both panes are per-tab and either can be closed
 * (never both: `paneVisibility()` guarantees one survives), so a tab can be
 * preview-only or editor-only while its neighbours are split.
 * `marked`/`DOMPurify` and `mermaid` load lazily on first use so app start and
 * non-preview use pay nothing (see plan: 무게 검토).
 */
import { save, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode } from "@lezer/highlight";
import { StyleModule } from "style-mod";
import { store } from "./state";
import { currentDoc, getView } from "./editor";
import { ipc } from "./ipc";
import { effectiveFileType, highlightStyle } from "./language";
import { refreshStatusBar } from "./statusbar";
import { resolvedMode } from "./theme";
import {
  mountMermaidView,
  frameDiagram,
  setSoloMode,
  closeMermaidPopover,
  setPreviewSelected,
  applyMermaidZoom,
  previewZoomFactor,
  setPreviewZoomHandler,
} from "./mermaid-view";
import { setPreviewEnabled, previewRatio, previewContentWidth } from "./settings";

let splitEl: HTMLElement;
let editorHost: HTMLElement;
let previewHost: HTMLElement;
let dividerEl: HTMLElement;
/** The two pane × buttons. The preview's lives outside `#preview-host` (a
 *  sibling in `#split`) so it escapes both that pane's scrolling and the
 *  `replaceChildren()` in ensureMdBody(); the editor's sits inside its host,
 *  which never has its children swapped and clips its own overflow. */
let editorCloseEl: HTMLElement;
let previewCloseEl: HTMLElement;

// ---- Lazy renderer modules (marked + DOMPurify) ----------------------------

type Marked = typeof import("marked")["marked"];
type Purify = typeof import("dompurify")["default"];
let mods: { marked: Marked; DOMPurify: Purify } | null = null;
let loading: Promise<{ marked: Marked; DOMPurify: Purify }> | null = null;

function ensureMods(): Promise<{ marked: Marked; DOMPurify: Purify }> {
  if (mods) return Promise.resolve(mods);
  if (!loading) {
    loading = Promise.all([import("marked"), import("dompurify")]).then(
      ([{ marked }, { default: DOMPurify }]) => {
        marked.setOptions({ gfm: true, breaks: false });
        // Fenced code is left as plain `<pre><code class="language-…">` by marked;
        // it's syntax-highlighted after sanitize by reusing CodeMirror's own
        // grammars + HighlightStyle (highlightCodeBlocks), so the preview shares
        // the exact token→color palette with the editor and ships no separate
        // highlighter in the entry bundle.
        mods = { marked, DOMPurify };
        return mods;
      },
    );
  }
  return loading;
}

// ---- Fenced code highlighting (reuses the editor's CM grammars) ------------

/** Mount the shared HighlightStyle's CSS rules into the document once, so the
 *  token spans produced below pick up the same `--cm-*` palette the editor uses.
 *  (The editor mounts them too, but not necessarily before the first preview.) */
let highlightStyleMounted = false;
function ensureHighlightStyleMounted(): void {
  if (highlightStyleMounted) return;
  if (highlightStyle.module) StyleModule.mount(document, highlightStyle.module);
  highlightStyleMounted = true;
}

/** Replace a `<code>` block's text with CodeMirror-highlighted token spans,
 *  using the shared HighlightStyle so colors follow the active theme. */
function highlightInto(codeEl: HTMLElement, support: LanguageSupport): void {
  const code = codeEl.textContent ?? "";
  const tree = support.language.parser.parse(code);
  const frag = document.createDocumentFragment();
  highlightCode(
    code,
    tree,
    highlightStyle,
    (text, classes) => {
      if (classes) {
        const span = document.createElement("span");
        span.className = classes;
        span.textContent = text;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(text));
      }
    },
    () => frag.appendChild(document.createTextNode("\n")),
  );
  codeEl.replaceChildren(frag);
}

/** Syntax-highlight every ```lang fenced block whose language CodeMirror knows,
 *  loading each grammar lazily via @codemirror/language-data. Mermaid blocks are
 *  skipped (renderMermaid turns them into diagrams). Unknown languages stay
 *  plain. Re-checks the render token after each async load so a superseded
 *  render never injects into a rebuilt (or hidden) preview. */
async function highlightCodeBlocks(mdBody: HTMLElement, myRun: number): Promise<void> {
  const blocks = mdBody.querySelectorAll<HTMLElement>('pre code[class*="language-"]');
  if (blocks.length === 0) return;
  ensureHighlightStyleMounted();
  for (const codeEl of Array.from(blocks)) {
    const name = /language-([\w+#.-]+)/.exec(codeEl.className)?.[1];
    if (!name || name === "mermaid") continue; // mermaid → renderMermaid handles it
    const desc = LanguageDescription.matchLanguageName(languages, name, true);
    if (!desc) continue; // unknown language → leave the block plain
    let support: LanguageSupport;
    try {
      support = await desc.load();
    } catch {
      continue; // a grammar chunk failed to load; leave this block plain
    }
    // A newer render (fast edit / tab switch / theme change) superseded this one,
    // or the pane was hidden: the mdBody these nodes live in is stale — abort.
    if (renderSeq !== myRun || previewHost.hidden) return;
    highlightInto(codeEl, support);
  }
}

// ---- Mermaid (lazy, only when a diagram is present) ------------------------

type MermaidMod = typeof import("mermaid")["default"];
let mermaidMod: MermaidMod | null = null;
let mermaidLoading: Promise<MermaidMod> | null = null;

/** Load mermaid on first use. Kept out of ensureMods() so plain Markdown never
 *  pays for the (large) mermaid bundle — it loads only when a ```mermaid block
 *  actually appears in the rendered document. */
function ensureMermaid(): Promise<MermaidMod> {
  if (mermaidMod) return Promise.resolve(mermaidMod);
  if (!mermaidLoading) {
    mermaidLoading = import("mermaid").then(({ default: m }) => {
      mermaidMod = m;
      return m;
    });
  }
  return mermaidLoading;
}

/** Resolve the effective dark/light mode for mermaid's baked-in SVG colors.
 *  Delegated to theme.ts rather than read off `data-theme`: that attribute now
 *  holds a composed "<family>-<mode>" value, and theme.ts is the one place that
 *  knows how "system" resolves. */
function effectiveDark(): boolean {
  return resolvedMode() === "dark";
}

// ---- Visibility / render ---------------------------------------------------

/** Whether the active tab *can* show a preview at all: a Markdown document or a
 *  standalone Mermaid diagram — by extension, or by an explicit pick in the
 *  status-bar type picker. Independent of whether the pane is currently open, so
 *  the status bar can offer a "Preview off" chip to turn it back on. */
export function isPreviewCapable(): boolean {
  // Large files run in reduced mode with no highlighting; rendering a multi-MB
  // Markdown/Mermaid preview would defeat that, so suppress it entirely.
  if (store.activeTab?.largeFile) return false;
  const ft = effectiveFileType(store.activeTab);
  return ft === "markdown" || ft === "mermaid";
}

/**
 * The real visibility of both panes. The tab's `editorVisible`/`previewVisible`
 * are advisory; this derives the answer and guarantees at least one pane is up.
 *
 * The editor comes back automatically whenever the preview can't be shown — a
 * type change away from Markdown, a reload into large-file mode — without
 * clearing `editorVisible`, so switching back restores what the user asked for.
 */
function paneVisibility(): { editor: boolean; preview: boolean } {
  const tab = store.activeTab;
  const preview = isPreviewCapable() && tab?.previewVisible !== false;
  return { editor: preview ? tab?.editorVisible !== false : true, preview };
}

/** Whether the editor pane is currently shown. Editor-only commands (find,
 *  replace, go-to-line) consult this before opening a panel that lives inside
 *  the editor's DOM. */
export function isEditorPaneVisible(): boolean {
  return !!editorHost && !editorHost.hidden;
}

/** The `.md-body` child that holds rendered Markdown (created on first use). */
function ensureMdBody(): HTMLElement {
  let el = previewHost.querySelector<HTMLElement>(".md-body");
  if (!el) {
    previewHost.replaceChildren();
    el = document.createElement("div");
    el.className = "md-body";
    previewHost.appendChild(el);
  }
  return el;
}

/** Monotonic render token: each renderNow() call claims one, and any await
 *  that resumes with a stale token aborts — prevents a superseded render (fast
 *  editing / tab switch / theme change) from injecting stale output. */
let renderSeq = 0;

async function renderNow(): Promise<void> {
  if (previewHost.hidden) return;
  const myRun = ++renderSeq;
  // Captured once: every branch below must agree on one type, even across awaits.
  const ft = effectiveFileType(store.activeTab);

  // Both of these must run before either branch and, critically, before any
  // await. Parked in ensureMods(), a Markdown run would resume *after* a later
  // Mermaid run had already finished and would then clear its solo class,
  // trapping that diagram in the 72ch column; the renderSeq guard below does
  // stop the stale run, but only once it has resumed — too late. Closing the
  // popover here covers the anchor this render is about to destroy (a native
  // menu click never fires the webview's outside-mousedown handler).
  setSoloMode(ft === "mermaid");
  closeMermaidPopover();

  // Mermaid: the whole document is one diagram, so skip Markdown parsing (and
  // its marked/DOMPurify load) and render it directly.
  if (ft === "mermaid") {
    const mdBody = ensureMdBody();
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = currentDoc(); // textContent → exact source, no escaping
    pre.appendChild(code);
    mdBody.replaceChildren(pre);
    await renderMermaid(mdBody, myRun);
    return;
  }

  const { marked, DOMPurify } = await ensureMods();
  // Re-check after the async load: the tab may have switched, hidden, or a
  // newer render superseded this one.
  if (renderSeq !== myRun || previewHost.hidden) return;
  if (ft !== "markdown") return;
  const doc = currentDoc();
  const mdBody = ensureMdBody();
  mdBody.innerHTML = DOMPurify.sanitize(marked.parse(doc) as string);
  wrapTables(mdBody);
  await highlightCodeBlocks(mdBody, myRun);
  if (renderSeq !== myRun || previewHost.hidden) return;
  await renderMermaid(mdBody, myRun);
}

/** Give every table its own horizontal scroll viewport.
 *
 *  The overflow used to live on the table itself via `display:block`, which cost
 *  the table its table layout — it sized to its content and ignored the pane (see
 *  the `.md-table-wrap` note in styles.css). Moving the viewport to a wrapper
 *  lets the table stay `display:table` and fill the width, while a table too wide
 *  to wrap (long URLs, code) still scrolls instead of overflowing the pane.
 *
 *  Built with DOM calls rather than innerHTML so nothing re-enters the parser
 *  after DOMPurify has run. Tables nested in a blockquote or list get a wrapper
 *  too — the wrapper takes the table's place, so the surrounding structure and
 *  the top-level column cap both keep applying to it. */
function wrapTables(mdBody: HTMLElement): void {
  for (const table of Array.from(mdBody.querySelectorAll("table"))) {
    // Re-render reuses no nodes, but guard anyway so a wrapper is never nested.
    if (table.parentElement?.classList.contains("md-table-wrap")) continue;
    const wrap = document.createElement("div");
    wrap.className = "md-table-wrap";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

/** Replace ```mermaid code blocks with rendered SVG diagrams. The block's
 *  source survives as plain text in `code.language-mermaid` (highlightCodeBlocks
 *  skips mermaid), so we read it and hand it to mermaid. mermaid's own
 *  securityLevel:"strict" sanitizes the SVG. */
async function renderMermaid(mdBody: HTMLElement, myRun: number): Promise<void> {
  const blocks = mdBody.querySelectorAll<HTMLElement>("code.language-mermaid");
  if (blocks.length === 0) return;
  const mermaid = await ensureMermaid();
  if (renderSeq !== myRun || previewHost.hidden) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: effectiveDark() ? "dark" : "default",
  });
  let i = 0;
  for (const codeEl of Array.from(blocks)) {
    const src = codeEl.textContent ?? "";
    const target = codeEl.closest("pre") ?? codeEl;
    const id = `mmd-${myRun}-${i++}`;
    try {
      const { svg } = await mermaid.render(id, src);
      if (renderSeq !== myRun) return; // a newer render superseded this one
      const container = document.createElement("div");
      container.className = "mermaid-diagram";
      container.innerHTML = svg;
      // Wrapped in a frame that carries the toolbar and the chart's natural
      // size; see mermaid-view.ts for why neither can live on the chart node.
      target.replaceWith(frameDiagram(container));
    } catch (e) {
      // mermaid can leave a temp measuring node behind on parse failure.
      document.getElementById("d" + id)?.remove();
      if (renderSeq !== myRun) return;
      const err = document.createElement("pre");
      err.className = "mermaid-error";
      err.textContent = `Mermaid 렌더 오류: ${(e as Error).message}`;
      target.replaceWith(err);
    }
  }
}

// ---- Selected pane (zoom target) -------------------------------------------

/**
 * Which pane the View ▸ Zoom items act on. Hover alone can't answer that for
 * the menu path (the mouse is on the menu when the item is clicked), so clicks
 * select a pane and mermaid-view's zoom routing honors the selection first,
 * hover second. The selected pane gets a `pane-selected` outline — but only
 * while both panes are visible; with the preview hidden there is nothing to
 * disambiguate and a permanent outline would just be noise.
 */
function setSelectedPane(preview: boolean): void {
  setPreviewSelected(preview);
  const both = !previewHost.hidden && !editorHost.hidden;
  previewHost.classList.toggle("pane-selected", both && preview);
  editorHost.classList.toggle("pane-selected", both && !preview);
}

/** Show/hide both panes per the current tab, and render the preview if visible.
 *  Call on tab switch, pane toggle, and Save As (extension may change md status). */
export function updatePanes(): void {
  const { editor, preview } = paneVisibility();
  const revealingEditor = editorHost.hidden && editor;

  previewHost.hidden = !preview;
  editorHost.hidden = !editor;
  // Preview with the whole window to itself: CSS drops the readable-column cap
  // so the text reaches the scrollbar instead of stranding it an empty half-pane
  // away. Alongside the editor the cap still earns its keep.
  previewHost.classList.toggle("pane-only", preview && !editor);
  // The divider only means anything when there is something on both sides of it;
  // left alone it would be a 6px col-resize strip that drags to no visible effect.
  dividerEl.hidden = !(editor && preview);
  // Close buttons only when there is a second pane to fall back to — the last
  // remaining pane can't be closed, so offering an × there would be a dead end.
  editorCloseEl.hidden = !(editor && preview);
  previewCloseEl.hidden = !(editor && preview);

  // A hidden pane can't stay selected (its outline is gone and menu zoom would
  // silently target an invisible chart). With the editor closed the preview is
  // the only zoom target, so it has to start out selected — hover alone can't
  // answer for the menu path, where the pointer sits on the menu.
  setSelectedPane(!editor);
  applyRatio();
  applyPreviewZoom(); // re-apply this tab's preview zoom (text + diagrams)
  if (preview) void renderNow();

  if (revealingEditor) {
    // CodeMirror measures nothing while display:none, and the ResizeObserver
    // that would eventually notice is both debounced and gated on a 75ms
    // last-update guard. Measure explicitly, then restore the scroll position
    // that showTab's rAF couldn't apply to a hidden scroller.
    const view = getView();
    view.requestMeasure();
    const top = store.activeTab?.scrollTop ?? 0;
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = top;
    });
  }

  refreshStatusBar(); // the pane chips double as the way to reopen a closed pane
}

let renderTimer: number | null = null;

/** Debounced re-render for live editing; no-op while the pane is hidden. */
export function schedulePreviewRender(): void {
  if (previewHost.hidden) return;
  if (renderTimer !== null) clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    void renderNow();
  }, 200);
}

/** Flip the active tab's preview pane (View ▸ Toggle Preview / Cmd+Shift+M,
 *  the × on the pane, the status-bar chip). The global setting follows along as
 *  the seed for tabs opened afterwards. No-op on a tab that can't preview. */
export function togglePreview(): void {
  const tab = store.activeTab;
  if (!tab || !isPreviewCapable()) return;
  tab.previewVisible = !tab.previewVisible;
  // Closing the preview leaves the editor as the only pane; make sure the flag
  // agrees, or reopening the preview would come back to an empty split.
  if (!tab.previewVisible) tab.editorVisible = true;
  setPreviewEnabled(tab.previewVisible);
  updatePanes();
}

/**
 * Bring the editor pane back if the user closed it. Editor-only commands (find,
 * replace, go-to-line, find next/prev) mount their panels inside the editor's
 * own DOM, so running them against a hidden editor silently does nothing —
 * worse for Replace, whose focus/retry dance can never succeed. Call this first.
 */
export function revealEditorPane(): void {
  const tab = store.activeTab;
  if (!tab || isEditorPaneVisible()) return;
  tab.editorVisible = true;
  updatePanes();
}

/** Flip the active tab's editor pane. Only possible while the preview is up —
 *  otherwise this would close the last pane and leave an empty window. */
export function toggleEditorPane(): void {
  const tab = store.activeTab;
  if (!tab) return;
  const { editor, preview } = paneVisibility();
  if (!preview) return; // nothing to fall back to
  tab.editorVisible = !editor;
  updatePanes();
}

// ---- Editor → preview scroll sync ------------------------------------------

/** Map the editor's scroll fraction onto the preview pane. No-op when the pane
 *  is hidden or unscrollable. Diagram-only (Mermaid) documents have nothing to
 *  track, so this naturally only matters for Markdown. */
function syncPreviewScroll(): void {
  if (previewHost.hidden) return;
  const ed = getView().scrollDOM;
  const edRange = ed.scrollHeight - ed.clientHeight;
  if (edRange <= 0) return;
  const frac = ed.scrollTop / edRange;
  const pvRange = previewHost.scrollHeight - previewHost.clientHeight;
  previewHost.scrollTop = frac * pvRange;
}

// ---- Links -----------------------------------------------------------------

/** Schemes handed to the OS. `mailto:` is here because a document that lists an
 *  address expects the mail client, not silence. */
const OPENABLE_SCHEME = /^(?:https?|mailto):/i;

/**
 * Clicks on links inside the rendered document. Delegated to the host so the
 * handler survives the re-renders that rebuild `.md-body`.
 *
 * Every link click is cancelled first, and that is the point: an uncancelled
 * `<a href="https://…">` navigates *this* webview, so the app UI is replaced by
 * the site with no back button and no way home — the session survives on disk,
 * but the window is gone until it is restarted. Nothing may reach the default
 * action.
 *
 * What happens instead depends on the href:
 *  - `#anchor` → scroll within this DOM. marked emits no heading ids by default,
 *    so most of these find nothing today; that is a miss, not a navigation.
 *  - http(s)/mailto → the OS default app, which is the "open elsewhere" a
 *    webview cannot offer on its own. Matches the VS Code extension, which
 *    routes the same click through its host (`vscode-ext/webview/preview.ts`).
 *  - anything else, including the relative paths a document uses to point at its
 *    neighbours → dropped. The webview's origin is the app bundle, so resolving
 *    a relative path here would produce an app-internal URL that means nothing
 *    to the browser. Resolving those against the tab's own file (and opening
 *    them as tabs) would be a real feature; guessing is worse than doing nothing.
 */
function onPreviewLinkClick(e: MouseEvent): void {
  // Element, not HTMLAnchorElement: mermaid diagrams can carry SVG <a> nodes.
  const a = (e.target as Element | null)?.closest("a[href]");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    previewHost
      .querySelector(`[id="${CSS.escape(href.slice(1))}"]`)
      ?.scrollIntoView({ block: "start" });
    return;
  }
  if (!OPENABLE_SCHEME.test(href)) return;
  // Surface failures: a scope rejection is otherwise indistinguishable from a
  // dead link, since nothing visible happens either way.
  void openUrl(href).catch((err) => console.error("openUrl failed", err));
}

// ---- Export / print --------------------------------------------------------

/** The rendered preview HTML for the active tab, or null if nothing is shown. */
function renderedHtml(): string | null {
  if (previewHost.hidden) return null;
  return previewHost.querySelector<HTMLElement>(".md-body")?.innerHTML ?? null;
}

/** Export the rendered preview as a standalone, self-contained HTML file.
 *  Written through the same Rust save path as documents (UTF-8/LF). */
export async function exportPreviewHtml(): Promise<void> {
  const body = renderedHtml();
  if (body === null) {
    await message("Open the preview (Markdown/Mermaid) before exporting.", {
      title: "UniNotepad",
      kind: "info",
    });
    return;
  }
  const tab = store.activeTab;
  const title = tab ? tab.title : "export";
  const defaultName = title.replace(/\.[^.]+$/, "") + ".html";
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (!path) return;
  const doc = htmlDocument(title, body);
  try {
    // UTF-8 is lossless for any string, so allowLossy is a formality here.
    await ipc.saveFile(path, doc, "utf8", "lf", true);
  } catch (err) {
    await message(`Failed to export:\n${err}`, { title: "UniNotepad", kind: "error" });
  }
}

/** Wrap rendered body HTML in a minimal, self-contained HTML5 document. */
function htmlDocument(title: string, body: string): string {
  const esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc}</title>
<style>
  /* Same split as the preview pane: the text keeps a readable column, a Mermaid
     diagram gets the whole page. */
  body { margin: 2rem auto; padding: 0 1rem; max-width: 1600px;
    font: 16px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; }
  body > *:not(.mermaid-frame) { max-width: 44rem; margin-inline: auto; }
  pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 6px; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 1rem; color: #555; }
  /* Tables arrive wrapped in the scroll container the preview gives them, so the
     rules here mirror styles.css: the wrapper owns the flow margin and the
     overflow, and the table fills it unless its cells refuse to wrap. */
  .md-table-wrap { overflow-x: auto; margin: 0.8em 0; }
  table { border-collapse: collapse; width: auto; min-width: 100%; margin: 0; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; }
  img, svg { max-width: 100%; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Open the OS print dialog. A print stylesheet (styles.css @media print) hides
 *  everything except the preview body, so "Save as PDF" yields the document. */
export function printPreview(): void {
  if (previewHost.hidden) {
    void message("Open the preview (Markdown/Mermaid) before printing.", {
      title: "UniNotepad",
      kind: "info",
    });
    return;
  }
  window.print();
}

// ---- Split ratio / divider drag --------------------------------------------

/** Editor:preview split bounds — keeps either pane from collapsing (mirrors
 *  settings.ts RATIO_MIN/MAX, applied per-tab here). */
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;

/** The base Markdown text size (px) at 100%; scaled by the preview zoom factor. */
const PREVIEW_BASE_FONT = 15;

function applyRatio(): void {
  // The split ratio only means anything with both panes up. A lone pane must
  // drop it entirely: flex-grow factors that sum to *less than 1* hand out only
  // that fraction of the free space, so a solo pane left carrying e.g. 0.5 fills
  // half the window and strands the rest — the ratio would silently become a
  // width cap. Clearing the inline value restores the stylesheet's `flex: 1 1 0`
  // (grow 1), which fills, and puts the scrollbar back at the window edge.
  if (previewHost.hidden || editorHost.hidden) {
    editorHost.style.flexGrow = "";
    previewHost.style.flexGrow = "";
    return;
  }
  // Per-tab ratio, falling back to the global default (new-tab seed) before any
  // tab is mounted.
  const r = store.activeTab?.previewRatio ?? previewRatio();
  editorHost.style.flexGrow = String(r);
  previewHost.style.flexGrow = String(1 - r);
}

/** Push the active tab's preview zoom to both the Markdown text
 *  (`--preview-font-size`) and the Mermaid diagrams (`--mmd-zoom`, via
 *  mermaid-view). Registered as mermaid-view's zoom handler so a shortcut press
 *  routes back here for the text half. */
function applyPreviewZoom(): void {
  if (!previewHost) return;
  const factor = previewZoomFactor();
  previewHost.style.setProperty("--preview-font-size", `${PREVIEW_BASE_FONT * factor}px`);
  applyContentWidth(factor);
  applyMermaidZoom();
}

/**
 * Push the text-column cap to CSS as `--md-col`.
 *
 * Scaled by the zoom factor for the same reason the font size is: zooming in
 * should widen the column along with the glyphs, or the text just reflows into
 * fewer words per line. `none` (not `0`) is what the settings' 0 becomes — CSS
 * `max-width: 0` would collapse the column to nothing.
 */
function applyContentWidth(factor: number): void {
  const px = previewContentWidth();
  previewHost.style.setProperty("--md-col", px > 0 ? `${Math.round(px * factor)}px` : "none");
}

/** Re-read the width setting and repaint. Called by Preferences, which can
 *  change it while a preview is on screen. */
export function refreshPreviewContentWidth(): void {
  if (!previewHost) return;
  applyContentWidth(previewZoomFactor());
}

/** The active tab's preview scale as a percentage, for the status bar. */
export function getPreviewZoomPercent(): number {
  return Math.round(previewZoomFactor() * 100);
}

/** Whether the preview pane is currently shown (drives the status-bar Preview %). */
export function isPreviewVisible(): boolean {
  return !!previewHost && !previewHost.hidden;
}

let dragging = false;

function onDividerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  dragging = true;
  dividerEl.setPointerCapture(e.pointerId);
  document.body.style.userSelect = "none";
  e.preventDefault();
}

function onDividerMove(e: PointerEvent): void {
  if (!dragging) return;
  const rect = splitEl.getBoundingClientRect();
  if (rect.width === 0) return;
  const tab = store.activeTab;
  if (!tab) return;
  const raw = (e.clientX - rect.left) / rect.width;
  tab.previewRatio = Math.max(RATIO_MIN, Math.min(RATIO_MAX, raw)); // per-tab ratio
  applyRatio();
}

function onDividerUp(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  document.body.style.userSelect = "";
  try {
    dividerEl.releasePointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
}

export function mountPreview(
  split: HTMLElement,
  editor: HTMLElement,
  preview: HTMLElement,
  divider: HTMLElement,
  editorClose: HTMLElement,
  previewClose: HTMLElement,
): void {
  splitEl = split;
  editorHost = editor;
  previewHost = preview;
  dividerEl = divider;
  editorCloseEl = editorClose;
  previewCloseEl = previewClose;
  editorClose.addEventListener("click", toggleEditorPane);
  previewClose.addEventListener("click", togglePreview);
  divider.addEventListener("pointerdown", onDividerDown);
  divider.addEventListener("pointermove", onDividerMove);
  divider.addEventListener("pointerup", onDividerUp);
  divider.addEventListener("pointercancel", onDividerUp);
  // Diagram backdrop/zoom/pan. Delegated to the host, so it survives the
  // re-renders that rebuild every chart node.
  mountMermaidView(preview);
  // A preview-zoom shortcut updates the tab exponent in mermaid-view; route it
  // back here so the Markdown text size follows the diagram scale. It also
  // mutates the tab field directly (no store emit), so refresh the status bar's
  // "Preview N%" by hand — applyPreviewZoom stays emit-free for the mount/switch
  // callers that already refresh.
  setPreviewZoomHandler(() => {
    applyPreviewZoom();
    refreshStatusBar();
  });

  // Pane selection for zoom routing. Clicks pick a pane; `focusin` also covers
  // the editor because CM6 takes focus through code paths (tab switch, find)
  // that produce no pointerdown on the host.
  preview.addEventListener("pointerdown", () => setSelectedPane(true));
  editor.addEventListener("pointerdown", () => setSelectedPane(false));
  editor.addEventListener("focusin", () => setSelectedPane(false));

  // Document links. Bound here rather than per render: `.md-body` is rebuilt on
  // every keystroke-debounced render, and a handler on it would die with it.
  preview.addEventListener("click", onPreviewLinkClick);

  // Editor → preview scroll sync (one-way, proportional). Bound once to the
  // single shared editor scroller; no-op while the pane is hidden. One-way only
  // to avoid the feedback loop a bidirectional sync would create.
  getView().scrollDOM.addEventListener("scroll", syncPreviewScroll, { passive: true });

  // Re-render when the theme changes so mermaid diagrams (baked-in SVG colors)
  // follow light/dark. This one event covers both causes now: explicit picks
  // *and* an OS light/dark flip while the mode is "system" — theme.ts owns the
  // matchMedia subscription and fires the same event after re-applying, so the
  // separate media listener that used to live here would only double-render.
  window.addEventListener("uninotepad:themechange", () => {
    if (!previewHost.hidden) void renderNow();
  });
}
