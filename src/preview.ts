/**
 * Markdown preview pane. Renders the active tab in a right-hand pane split from
 * the editor by a draggable divider: Markdown → sanitized HTML injected into a
 * `.md-body` div, with ```mermaid fenced blocks rendered as diagrams. A
 * standalone `.mmd`/`.mermaid` file is rendered whole as a single diagram.
 *
 * The pane shows when the toggle is ON (default) AND the active tab is a
 * Markdown or Mermaid file. `marked`/`DOMPurify` and `mermaid` load lazily on
 * first use so app start and non-preview use pay nothing (see plan: 무게 검토).
 *
 * Each rendered diagram carries hover controls (transparent / colored
 * background, persisted app-wide) and shares a session zoom level driven by
 * Cmd/Ctrl+= / - / 0 while the pointer is over the pane; a zoomed chart
 * scrolls and drag-pans inside its own viewport.
 */
import { store } from "./state";
import { currentDoc } from "./editor";
import { isMarkdownPath, isMermaidPath } from "./language";
import { refreshStatusBar } from "./statusbar";
import { themeChoice } from "./theme";
import {
  isPreviewEnabled,
  setPreviewEnabled,
  previewRatio,
  setPreviewRatio,
  mermaidBg,
  setMermaidBg,
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
 *  document or a standalone Mermaid diagram file. */
function shouldShow(): boolean {
  const path = store.activeTab?.path ?? null;
  return isPreviewEnabled() && (isMarkdownPath(path) || isMermaidPath(path));
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
  const path = store.activeTab?.path ?? null;
  // Standalone diagram tabs drop the Markdown reading-column layout so the
  // chart viewport fills the whole pane (see .mmd-standalone in styles.css).
  previewHost.classList.toggle("mmd-standalone", isMermaidPath(path));

  // Standalone .mmd/.mermaid file: the whole document is one diagram, so skip
  // Markdown parsing (and its marked/DOMPurify load) and render it directly.
  if (isMermaidPath(path)) {
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
  if (!isMarkdownPath(path)) return;
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
      // Inner scroll viewport: when the chart is zoomed past the pane width
      // it scrolls (and drag-pans) here while the hover toolbar stays put.
      const scroll = document.createElement("div");
      scroll.className = "mermaid-scroll";
      scroll.innerHTML = svg;
      container.appendChild(scroll);
      attachMermaidControls(container);
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
  applyMermaidView();
}

// ---- Mermaid view controls: background + zoom -------------------------------

/** Chart magnification bounds/step (multiplicative; snaps back to exactly 1). */
const MMD_ZOOM_MIN = 0.25;
const MMD_ZOOM_MAX = 4;
const MMD_ZOOM_STEP = 1.25;

/** Session-scoped zoom shared by every diagram in the pane (1 = fit as-is). */
let mermaidZoom = 1;

function hexToRgba(hex: string, alphaPct: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alphaPct / 100})`;
}

/** Re-apply the persisted background and current zoom to every rendered
 *  diagram. Idempotent — runs after each render and on every control change.
 *  Background is a CSS var so changing it never re-renders mermaid. */
function applyMermaidView(): void {
  const bg = mermaidBg();
  const hasBg = bg.mode === "color";
  previewHost.style.setProperty(
    "--mermaid-bg",
    hasBg ? hexToRgba(bg.color, bg.alpha) : "transparent",
  );
  previewHost.classList.toggle("mmd-bg-on", hasBg);
  previewHost.classList.toggle("mmd-zoomed", mermaidZoom !== 1);
  for (const svg of previewHost.querySelectorAll<SVGSVGElement>(".mermaid-scroll > svg")) {
    if (mermaidZoom === 1) {
      svg.style.width = ""; // stock behavior: fit to pane via max-width:100%
      continue;
    }
    const viewport = svg.parentElement;
    if (!viewport) continue;
    // Base = width at 100% (natural size capped to the viewport), so the
    // first zoom step grows smoothly from what is on screen.
    const natural = svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width;
    const base = Math.min(natural, viewport.clientWidth);
    if (base > 0) svg.style.width = `${Math.round(base * mermaidZoom)}px`;
  }
  for (const diagram of previewHost.querySelectorAll<HTMLElement>(".mermaid-diagram")) {
    diagram.querySelector(".mmd-bg-clear")?.classList.toggle("active", !hasBg);
    diagram.querySelector(".mmd-bg-pick")?.classList.toggle("active", hasBg);
  }
}

function setMermaidZoom(z: number): void {
  const clamped = Math.min(MMD_ZOOM_MAX, Math.max(MMD_ZOOM_MIN, z));
  mermaidZoom = Math.abs(clamped - 1) < 0.001 ? 1 : clamped;
  applyMermaidView();
  showZoomBadge();
}

/** Chart zoom, wired to Cmd/Ctrl+= / - / 0 while the pointer is over the
 *  preview pane (menu.ts / main.ts route via previewMermaidHovered()). */
export function mermaidZoomIn(): void {
  setMermaidZoom(mermaidZoom * MMD_ZOOM_STEP);
}

export function mermaidZoomOut(): void {
  setMermaidZoom(mermaidZoom / MMD_ZOOM_STEP);
}

export function mermaidZoomReset(): void {
  setMermaidZoom(1);
}

/** True when the zoom keys should target diagrams instead of the editor font:
 *  the pane is visible, the pointer is over it, and it shows a diagram. */
export function previewMermaidHovered(): boolean {
  return (
    !!previewHost &&
    !previewHost.hidden &&
    previewHost.matches(":hover") &&
    previewHost.querySelector(".mermaid-diagram") !== null
  );
}

let zoomBadgeEl: HTMLElement | null = null;
let zoomBadgeTimer: number | null = null;

/** Flash the current zoom level near the pane's top-right corner. */
function showZoomBadge(): void {
  if (!zoomBadgeEl) {
    zoomBadgeEl = document.createElement("div");
    zoomBadgeEl.className = "mermaid-zoom-badge";
    document.body.appendChild(zoomBadgeEl);
  }
  const rect = previewHost.getBoundingClientRect();
  zoomBadgeEl.style.top = `${Math.round(rect.top + 10)}px`;
  zoomBadgeEl.style.right = `${Math.round(window.innerWidth - rect.right + 20)}px`;
  zoomBadgeEl.textContent = `${Math.round(mermaidZoom * 100)}%`;
  zoomBadgeEl.classList.add("show");
  if (zoomBadgeTimer !== null) clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = window.setTimeout(() => {
    zoomBadgeTimer = null;
    zoomBadgeEl?.classList.remove("show");
  }, 900);
}

/** Per-diagram hover overlay: 투명 배경 / 배경 색상 buttons plus a color+opacity
 *  popover. The chosen background is app-wide (persisted in settings) — the
 *  controls just live on each diagram for reach, and are rebuilt with it on
 *  every render. */
function attachMermaidControls(diagram: HTMLElement): void {
  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-toolbar";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "mmd-bg-clear";
  clearBtn.textContent = "투명 배경";
  clearBtn.title = "차트 배경을 투명하게";

  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.className = "mmd-bg-pick";
  pickBtn.textContent = "배경 색상";
  pickBtn.title = "차트 배경 색상과 불투명도 설정";
  toolbar.append(clearBtn, pickBtn);

  const popover = document.createElement("div");
  popover.className = "mermaid-bg-popover";
  popover.hidden = true;

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.title = "배경 색상 (RGB)";

  const alphaLabel = document.createElement("label");
  alphaLabel.append("불투명도 ");
  const alphaInput = document.createElement("input");
  alphaInput.type = "range";
  alphaInput.min = "0";
  alphaInput.max = "100";
  alphaInput.step = "1";
  const alphaValue = document.createElement("span");
  alphaValue.className = "mmd-alpha-value";
  alphaLabel.append(alphaInput, alphaValue);
  popover.append(colorInput, alphaLabel);

  const closePopover = (): void => {
    popover.hidden = true;
    diagram.classList.remove("mmd-popover-open");
  };

  clearBtn.addEventListener("click", () => {
    setMermaidBg({ ...mermaidBg(), mode: "transparent" });
    closePopover();
    applyMermaidView();
  });
  pickBtn.addEventListener("click", () => {
    if (!popover.hidden) {
      closePopover();
      return;
    }
    const bg = { ...mermaidBg(), mode: "color" as const };
    setMermaidBg(bg);
    colorInput.value = bg.color;
    alphaInput.value = String(bg.alpha);
    alphaValue.textContent = `${bg.alpha}%`;
    popover.hidden = false;
    diagram.classList.add("mmd-popover-open");
    applyMermaidView();
  });
  const onPick = (): void => {
    const alpha = Math.round(Number(alphaInput.value));
    setMermaidBg({ mode: "color", color: colorInput.value, alpha });
    alphaValue.textContent = `${alpha}%`;
    applyMermaidView();
  };
  colorInput.addEventListener("input", onPick);
  alphaInput.addEventListener("input", onPick);

  diagram.append(toolbar, popover);
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

  // Drag-to-pan a zoomed diagram: dragging inside its scroll viewport scrolls
  // it, so covered regions are reachable without the scrollbars. Delegated on
  // the pane because diagrams are rebuilt on every render.
  let panViewport: HTMLElement | null = null;
  let panPointerId = -1;
  let panOriginX = 0;
  let panOriginY = 0;
  let panScrollLeft = 0;
  let panScrollTop = 0;
  preview.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest(".mermaid-toolbar, .mermaid-bg-popover")) return;
    const viewport = target.closest<HTMLElement>(".mermaid-scroll");
    if (!viewport) return;
    const canPan =
      viewport.scrollWidth > viewport.clientWidth ||
      viewport.scrollHeight > viewport.clientHeight;
    if (!canPan) return;
    panViewport = viewport;
    panPointerId = e.pointerId;
    panOriginX = e.clientX;
    panOriginY = e.clientY;
    panScrollLeft = viewport.scrollLeft;
    panScrollTop = viewport.scrollTop;
    viewport.setPointerCapture(e.pointerId);
    viewport.style.cursor = "grabbing";
    e.preventDefault(); // no text selection while panning
  });
  preview.addEventListener("pointermove", (e) => {
    if (!panViewport || e.pointerId !== panPointerId) return;
    panViewport.scrollLeft = panScrollLeft - (e.clientX - panOriginX);
    panViewport.scrollTop = panScrollTop - (e.clientY - panOriginY);
  });
  const endPan = (e: PointerEvent): void => {
    if (!panViewport || e.pointerId !== panPointerId) return;
    panViewport.style.cursor = "";
    try {
      panViewport.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    panViewport = null;
    panPointerId = -1;
  };
  preview.addEventListener("pointerup", endPan);
  preview.addEventListener("pointercancel", endPan);

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
