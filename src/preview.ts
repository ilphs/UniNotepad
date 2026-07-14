/**
 * Markdown preview pane. Renders the active tab in a right-hand pane split from
 * the editor by a draggable divider: Markdown → sanitized HTML injected into a
 * `.md-body` div.
 *
 * The pane shows when the toggle is ON (default) AND the active tab is a
 * Markdown file. `marked` + `DOMPurify` load lazily on first render so app
 * start and non-preview use pay nothing (see plan: 무게 검토).
 */
import { store } from "./state";
import { currentDoc } from "./editor";
import { isMarkdownPath } from "./language";
import { refreshStatusBar } from "./statusbar";
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
        mods = { marked, DOMPurify };
        return mods;
      },
    );
  }
  return loading;
}

// ---- Visibility / render ---------------------------------------------------

/** Preview shows when enabled and the active tab is a Markdown file. */
function shouldShow(): boolean {
  return isPreviewEnabled() && isMarkdownPath(store.activeTab?.path ?? null);
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

async function renderNow(): Promise<void> {
  if (previewHost.hidden) return;
  const { marked, DOMPurify } = await ensureMods();
  // Re-check after the async load: the tab may have switched or hidden.
  if (previewHost.hidden) return;
  if (!isMarkdownPath(store.activeTab?.path ?? null)) return;
  const doc = currentDoc();
  ensureMdBody().innerHTML = DOMPurify.sanitize(marked.parse(doc) as string);
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
}
