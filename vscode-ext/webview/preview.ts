/**
 * The render core: Markdown → sanitized HTML in a `.md-body` div, with ```mermaid
 * fenced blocks turned into diagrams, and a standalone `.mmd`/`.mermaid` document
 * rendered whole as a single diagram.
 *
 * Ported from UniNotepad's `src/preview.ts`, minus everything that was about
 * owning a split pane — the divider drag, per-tab pane visibility, the flex-grow
 * ratio, the selected-pane outline. VS Code's editor groups do all of that, so
 * roughly 250 lines of the original had no counterpart here and were dropped
 * rather than reimplemented.
 *
 * What survives unchanged is the part that was never about the app's chrome: the
 * monotonic render token that stops a superseded render from injecting into a
 * rebuilt DOM, and the lazy module loads. The dynamic `import()`s look pointless
 * in a single-file webview bundle, and in one sense they are — esbuild inlines
 * them when code splitting is off, which is exactly what we want, because a split
 * bundle would need every chunk URL rewritten through `asWebviewUri` to get past
 * the CSP. Keeping the `import()` shape means the module stays a drop-in against
 * the app's version.
 *
 * KNOWN GAP: fenced code blocks are not syntax-highlighted. The app reused
 * CodeMirror's own grammars via `@codemirror/language-data`, which is a
 * per-language dynamic import — the one thing the single-bundle constraint above
 * rules out. See README.
 */
import { post, setSourceUri, sourceUri } from "./host";
import {
  mountMermaidView,
  frameDiagram,
  setSoloMode,
  closeMermaidPopover,
  applyMermaidZoom,
  previewZoomFactor,
  setPreviewZoomHandler,
} from "./mermaid-view";
import type { PreviewFileType } from "../shared/protocol";

let previewHost: HTMLElement;

/** The document being rendered, as last pushed by the host. */
let docText = "";
let docType: PreviewFileType = "markdown";

/** The base Markdown text size (px) at 100%; scaled by the preview zoom factor. */
const PREVIEW_BASE_FONT = 15;

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
        mods = { marked, DOMPurify };
        return mods;
      },
    );
  }
  return loading;
}

// ---- Mermaid ---------------------------------------------------------------

type MermaidMod = typeof import("mermaid")["default"];
let mermaidMod: MermaidMod | null = null;
let mermaidLoading: Promise<MermaidMod> | null = null;

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

/**
 * Resolve the effective dark/light mode.
 *
 * VS Code stamps `vscode-light` / `vscode-dark` / `vscode-high-contrast` /
 * `vscode-high-contrast-light` on `document.body` in every webview, so this reads
 * the host's actual theme kind instead of the OS preference the app had to fall
 * back on. High contrast (dark) has no light suffix, which is why the light
 * variant is tested first.
 */
function effectiveDark(): boolean {
  const cls = document.body.classList;
  if (cls.contains("vscode-light") || cls.contains("vscode-high-contrast-light")) return false;
  return cls.contains("vscode-dark") || cls.contains("vscode-high-contrast");
}

// ---- Render ---------------------------------------------------------------

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

/** Monotonic render token: each renderNow() call claims one, and any await that
 *  resumes with a stale token aborts — prevents a superseded render (fast editing
 *  / theme change) from injecting stale output. */
let renderSeq = 0;

async function renderNow(): Promise<void> {
  const myRun = ++renderSeq;
  // Captured once: every branch below must agree on one type, even across awaits.
  const ft = docType;

  // Both of these must run before either branch and, critically, before any
  // await. Parked in ensureMods(), a Markdown run would resume *after* a later
  // Mermaid run had already finished and would then clear its solo class,
  // trapping that diagram in the readable column; the renderSeq guard below does
  // stop the stale run, but only once it has resumed — too late.
  setSoloMode(ft === "mermaid");
  closeMermaidPopover();

  // Mermaid: the whole document is one diagram, so skip Markdown parsing (and
  // its marked/DOMPurify load) and render it directly.
  if (ft === "mermaid") {
    const mdBody = ensureMdBody();
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = docText; // textContent → exact source, no escaping
    pre.appendChild(code);
    mdBody.replaceChildren(pre);
    await renderMermaid(mdBody, myRun);
    return;
  }

  const { marked, DOMPurify } = await ensureMods();
  // Re-check after the async load: a newer render may have superseded this one.
  if (renderSeq !== myRun) return;
  const mdBody = ensureMdBody();
  mdBody.innerHTML = DOMPurify.sanitize(marked.parse(docText) as string);
  await renderMermaid(mdBody, myRun);
}

/** Replace ```mermaid code blocks with rendered SVG diagrams. The block's source
 *  survives as plain text in `code.language-mermaid`, so we read it and hand it to
 *  mermaid. mermaid's own `securityLevel: "strict"` sanitizes the SVG. */
async function renderMermaid(mdBody: HTMLElement, myRun: number): Promise<void> {
  const blocks = mdBody.querySelectorAll<HTMLElement>("code.language-mermaid");
  if (blocks.length === 0) return;
  const mermaid = await ensureMermaid();
  if (renderSeq !== myRun) return;
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
      // Wrapped in a frame that carries the toolbar and the chart's natural size;
      // see mermaid-view.ts for why neither can live on the chart node.
      target.replaceWith(frameDiagram(container));
    } catch (e) {
      // mermaid can leave a temp measuring node behind on parse failure.
      document.getElementById("d" + id)?.remove();
      if (renderSeq !== myRun) return;
      const err = document.createElement("pre");
      err.className = "mermaid-error";
      err.textContent = `Mermaid render error: ${(e as Error).message}`;
      target.replaceWith(err);
    }
  }
}

// ---- Host-driven entry points ---------------------------------------------

/** Adopt a new document (or the same text under a new theme) and re-render. The
 *  host already debounces edits, so this renders immediately.
 *
 *  `uri` distinguishes a genuinely different document from a new revision of the
 *  current one, and only the former resets the scroll: keeping the offset across
 *  an edit is the whole point of the debounced push, while keeping it across a
 *  file switch would drop the reader somewhere arbitrary in a document they have
 *  not seen. The reset waits for the render because the pane has no scrollable
 *  range until the new content is in the DOM. */
export function setContent(text: string, fileType: PreviewFileType, uri: string): void {
  const switched = uri !== sourceUri();
  setSourceUri(uri);
  docText = text;
  docType = fileType;
  const rendering = renderNow();
  if (switched) void rendering.then(() => (previewHost.scrollTop = 0));
}

/** Map an editor scroll fraction onto the pane. No-op when there is nothing to
 *  scroll. Diagram-only (Mermaid) documents naturally have nothing to track. */
export function setScrollFraction(fraction: number): void {
  const range = previewHost.scrollHeight - previewHost.clientHeight;
  if (range <= 0) return;
  previewHost.scrollTop = fraction * range;
}

/** The rendered body HTML, for the host's Export command. */
export function renderedHtml(): string {
  return previewHost.querySelector<HTMLElement>(".md-body")?.innerHTML ?? "";
}

/** Push the preview zoom to the Markdown text (`--preview-font-size`) and the
 *  Mermaid diagrams (`--mmd-zoom`, via mermaid-view). Registered as
 *  mermaid-view's zoom handler so a zoom command routes back here for the text
 *  half. */
export function applyPreviewZoom(): void {
  const factor = previewZoomFactor();
  previewHost.style.setProperty("--preview-font-size", `${PREVIEW_BASE_FONT * factor}px`);
  applyMermaidZoom();
}

// ---- Links ---------------------------------------------------------------

/**
 * Rendered Markdown links, delegated to the host element so the handler survives
 * the re-renders that rebuild `.md-body`'s contents.
 *
 * In-document anchors are resolved here — the target lives in this DOM and a
 * round-trip to the extension could not do anything useful with it. Everything
 * else goes to the host, which knows whether a URI belongs in the browser or in
 * an editor. `id`-less headings mean `#anchor` links mostly miss today; marked
 * does not generate heading slugs by default, and adding a slugger is a follow-up
 * rather than something to fake here.
 */
function onHostClick(e: MouseEvent): void {
  const a = (e.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (!href) return;
  e.preventDefault();
  if (href.startsWith("#")) {
    const target = previewHost.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
    target?.scrollIntoView({ block: "start" });
    return;
  }
  post({ type: "openLink", href });
}

// ---- Mount ---------------------------------------------------------------

export function mountPreview(host: HTMLElement): void {
  previewHost = host;
  mountMermaidView(host);
  // A zoom command updates the exponent in mermaid-view; route it back here so
  // the Markdown text size follows the diagram scale.
  setPreviewZoomHandler(applyPreviewZoom);
  applyPreviewZoom();
  host.addEventListener("click", onHostClick);
}
