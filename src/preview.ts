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
import { store } from "./state";
import { currentDoc } from "./editor";
import { effectiveFileType } from "./language";
import { refreshStatusBar } from "./statusbar";
import { themeChoice } from "./theme";
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
    loading = Promise.all([
      import("marked"),
      import("dompurify"),
      import("marked-highlight"),
      import("highlight.js/lib/common"),
    ]).then(([{ marked }, { default: DOMPurify }, { markedHighlight }, { default: hljs }]) => {
      marked.setOptions({ gfm: true, breaks: false });
      // Syntax-highlight fenced code via highlight.js; the `hljs-*` span
      // classes it emits are themed by the shared --cm-* palette in styles.css.
      marked.use(
        markedHighlight({
          langPrefix: "hljs language-",
          highlight: (code, lang) =>
            hljs.highlight(code, {
              language: hljs.getLanguage(lang) ? lang : "plaintext",
            }).value,
        }),
      );
      mods = { marked, DOMPurify };
      return mods;
    });
  }
  return loading;
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
  await renderMermaid(mdBody, myRun);
}

/** Replace ```mermaid code blocks with rendered SVG diagrams. The block's
 *  source survives as plain text in `code.language-mermaid` (highlight.js
 *  treats the unknown language as plaintext), so we read it and hand it to
 *  mermaid. mermaid's own securityLevel:"strict" sanitizes the SVG. */
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
      target.replaceWith(container);
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

/** Show/hide the pane per the current tab + toggle, and render if visible.
 *  Call on tab switch, toggle, and Save As (extension may change md status). */
export function updatePreview(): void {
  const show = shouldShow();
  previewHost.hidden = !show;
  dividerEl.hidden = !show;
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
