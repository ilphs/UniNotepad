/**
 * Markdown preview pane. Renders the active tab in a right-hand pane split from
 * the editor by a draggable divider: Markdown → sanitized HTML injected into a
 * `.md-body` div, with ```mermaid fenced blocks rendered as diagrams. A
 * standalone `.mmd`/`.mermaid` file is rendered whole as a single diagram.
 *
 * The pane shows when the toggle is ON (default) AND the active tab's effective
 * type is Markdown or Mermaid — from its extension, or from an explicit pick in
 * the status bar. `marked`/`DOMPurify` and `mermaid` load lazily on
 * first use so app start and non-preview use pay nothing (see plan: 무게 검토).
 */
import { save, message } from "@tauri-apps/plugin-dialog";
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode } from "@lezer/highlight";
import { StyleModule } from "style-mod";
import { store } from "./state";
import { currentDoc, getView } from "./editor";
import { ipc } from "./ipc";
import { effectiveFileType, highlightStyle } from "./language";
import { refreshStatusBar } from "./statusbar";
import { themeChoice } from "./theme";
import {
  mountMermaidView,
  frameDiagram,
  setSoloMode,
  closeMermaidPopover,
  setPreviewSelected,
} from "./mermaid-view";
import {
  isPreviewEnabled,
  setPreviewEnabled,
  previewRatio,
  setPreviewRatio,
} from "./settings";

let splitEl: HTMLElement;
let editorHost: HTMLElement;
let previewHost: HTMLElement;
let dividerEl: HTMLElement;

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

/** Resolve the effective dark/light mode: explicit data-theme, else the OS. */
function effectiveDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

// ---- Visibility / render ---------------------------------------------------

/** Preview shows when enabled and the active tab is previewable: a Markdown
 *  document or a standalone Mermaid diagram — by extension, or by an explicit
 *  pick in the status-bar type picker. */
function shouldShow(): boolean {
  // Large files run in reduced mode with no highlighting; rendering a multi-MB
  // Markdown/Mermaid preview would defeat that, so suppress it entirely.
  if (store.activeTab?.largeFile) return false;
  const ft = effectiveFileType(store.activeTab);
  return isPreviewEnabled() && (ft === "markdown" || ft === "mermaid");
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
  await highlightCodeBlocks(mdBody, myRun);
  if (renderSeq !== myRun || previewHost.hidden) return;
  await renderMermaid(mdBody, myRun);
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
  const both = !previewHost.hidden;
  previewHost.classList.toggle("pane-selected", both && preview);
  editorHost.classList.toggle("pane-selected", both && !preview);
}

/** Show/hide the pane per the current tab + toggle, and render if visible.
 *  Call on tab switch, toggle, and Save As (extension may change md status). */
export function updatePreview(): void {
  const show = shouldShow();
  previewHost.hidden = !show;
  dividerEl.hidden = !show;
  // A hidden pane can't stay selected (its outline is gone and menu zoom would
  // silently target an invisible chart); re-showing starts from the editor too.
  setSelectedPane(false);
  applyRatio();
  if (show) void renderNow();
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

/** Flip the app-wide preview toggle (View menu / Cmd+Shift+M). */
export function togglePreview(): void {
  setPreviewEnabled(!isPreviewEnabled());
  updatePreview();
  refreshStatusBar();
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
  body { max-width: 48rem; margin: 2rem auto; padding: 0 1rem;
    font: 16px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; }
  pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 6px; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 1rem; color: #555; }
  table { border-collapse: collapse; } th, td { border: 1px solid #ccc; padding: 4px 8px; }
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

function applyRatio(): void {
  if (previewHost.hidden) {
    editorHost.style.flexGrow = ""; // back to CSS default → full width
    return;
  }
  const r = previewRatio();
  editorHost.style.flexGrow = String(r);
  previewHost.style.flexGrow = String(1 - r);
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
  setPreviewRatio((e.clientX - rect.left) / rect.width); // clamps 0.2–0.8
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
): void {
  splitEl = split;
  editorHost = editor;
  previewHost = preview;
  dividerEl = divider;
  divider.addEventListener("pointerdown", onDividerDown);
  divider.addEventListener("pointermove", onDividerMove);
  divider.addEventListener("pointerup", onDividerUp);
  divider.addEventListener("pointercancel", onDividerUp);
  // Diagram backdrop/zoom/pan. Delegated to the host, so it survives the
  // re-renders that rebuild every chart node.
  mountMermaidView(preview);

  // Pane selection for zoom routing. Clicks pick a pane; `focusin` also covers
  // the editor because CM6 takes focus through code paths (tab switch, find)
  // that produce no pointerdown on the host.
  preview.addEventListener("pointerdown", () => setSelectedPane(true));
  editor.addEventListener("pointerdown", () => setSelectedPane(false));
  editor.addEventListener("focusin", () => setSelectedPane(false));

  // Editor → preview scroll sync (one-way, proportional). Bound once to the
  // single shared editor scroller; no-op while the pane is hidden. One-way only
  // to avoid the feedback loop a bidirectional sync would create.
  getView().scrollDOM.addEventListener("scroll", syncPreviewScroll, { passive: true });

  // Re-render when the theme changes so mermaid diagrams (baked-in SVG colors)
  // follow light/dark. Explicit menu choices fire "uninotepad:themechange";
  // an OS change only matters while the app is following "system".
  window.addEventListener("uninotepad:themechange", () => {
    if (!previewHost.hidden) void renderNow();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeChoice() === "system" && !previewHost.hidden) void renderNow();
  });
}
