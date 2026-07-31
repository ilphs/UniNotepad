/**
 * Interaction layer for the Mermaid diagrams rendered by preview.ts: a backdrop
 * color, a zoom ladder with panning, and the full-panel "solo" layout used when
 * the whole document is one diagram (a standalone `.mmd`).
 *
 * Ported from UniNotepad's `src/mermaid-view.ts`. Two things changed and nothing
 * else needed to:
 *   - per-tab state (`store.activeTab.previewZoomExp`) became per-panel state in
 *     host.ts, because a VS Code preview panel *is* one document;
 *   - zoom no longer has to work out whether it was aimed at the preview. The app
 *     shared one window with its editor and had to disambiguate by
 *     selection-then-hover; here the host only forwards a zoom command while this
 *     panel is the active webview (`activeWebviewPanelId` in package.json), so
 *     arrival is the answer.
 *
 * The core invariant survives the port intact and is still what makes this cheap:
 * **state lives on `#preview-host`, never on a chart node.** The render pipeline
 * rebuilds every `.mermaid-diagram` from scratch on a 200ms typing debounce and on
 * theme change, and the render ids (`mmd-${run}-${i}`) change each time, so
 * nothing stored on a chart survives — whereas `#preview-host` is static markup
 * from the host's HTML shell that no render path replaces. Putting `--mmd-bg` /
 * `--mmd-zoom` / `.mmd-zoomed` / `.mmd-solo` there makes them survive re-renders
 * for free, with no restore logic.
 *
 * The one exception is per-chart natural size (`--mmd-nw`/`--mmd-nh`), which
 * genuinely differs per diagram and per theme, so frameDiagram() re-applies it on
 * every single render.
 *
 * Why the backdrop is a CSS variable and not a mermaid theme option: the host
 * variable is inherited by the SVG, so a change is a repaint. Routing it through
 * `mermaid.initialize({themeVariables})` would force a full re-render of every
 * diagram on the pane — dozens of renders for one slider drag.
 */
import {
  mermaidBg,
  setMermaidBg,
  mermaidBgEnabled,
  setMermaidBgEnabled,
  type MermaidBg,
} from "./settings";
import { setZoomExp, zoomExp } from "./host";

let hostEl: HTMLElement;

const LABEL_TRANSPARENT = "Transparent";
const LABEL_COLOR = "Backdrop";
const LABEL_OPACITY = "Opacity";

// ---- Zoom ladder -----------------------------------------------------------

/**
 * The scale is held as an *exponent*, never as the factor itself.
 *
 * With the factor as state, `zoom = clamp(zoom * 1.25, .25, 4)` pins at exactly
 * 4.0 — which is not a power of 1.25. Stepping back down from there gives
 * 3.2 → 2.56 → 2.048 → 1.6384 → 1.31072 → 1.048576 → 0.839…, i.e. it steps
 * straight over 1 and never lands on it. 1 is precisely the value that drops
 * `.mmd-zoomed` and returns the chart to in-flow layout, so the user could never
 * get back to the normal view. `ZOOM_BASE ** 0` is always exactly 1.
 */
const ZOOM_BASE = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

/**
 * Exponent bounds sit one step *past* where the clamp engages, so the ladder's
 * endpoints land on exactly 25% / 400% (the clamp supplies the final partial
 * step) while presses beyond that can't accumulate: an unbounded exponent would
 * let "+" pressed ten times at the ceiling build a backlog that then costs ten
 * dead presses of "-" before the chart moved at all.
 */
const EXP_MAX = Math.ceil(Math.log(ZOOM_MAX) / Math.log(ZOOM_BASE));
const EXP_MIN = Math.floor(Math.log(ZOOM_MIN) / Math.log(ZOOM_BASE));

/** The live preview scale. The clamp applies to the derived value only; the
 *  exponent ladder itself is what guarantees the walk back down hits 1 exactly.
 *  Exported so preview.ts can size the Markdown text (`--preview-font-size`) with
 *  the same factor this module applies to Mermaid diagrams. */
export function previewZoomFactor(): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, ZOOM_BASE ** zoomExp()));
}

/** Push the diagram scale to the host. Deliberately badge-free: this also runs
 *  at mount, where a flash would look like a bug. handleZoom() owns the badge. */
export function applyMermaidZoom(): void {
  const f = previewZoomFactor();
  hostEl.style.setProperty("--mmd-zoom", String(f));
  // At exactly 1 the zoom rules come off entirely, restoring the untouched
  // in-flow layout rather than an equivalent-looking reconstruction of it.
  hostEl.classList.toggle("mmd-zoomed", f !== 1);
}

// ---- Backdrop --------------------------------------------------------------

function bgCss(bg: MermaidBg, enabled: boolean): string {
  return enabled ? `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${bg.a})` : "transparent";
}

/** Push the stored backdrop to the host. Badge-free, for the same reason as
 *  applyMermaidZoom(). */
export function applyMermaidBg(): void {
  hostEl.style.setProperty("--mmd-bg", bgCss(mermaidBg(), mermaidBgEnabled()));
  refreshToolbarState();
}

// ---- Natural size ----------------------------------------------------------

/**
 * The chart's intrinsic px size, or null if it can't be established.
 *
 * Read from the viewBox because mermaid derives both from the same numbers:
 * `setupGraphViewbox` passes `svgBounds.width + 2*padding` to `configureSvgSize`
 * *and* into the viewBox string, so viewBox w/h == the px size mermaid would have
 * used. That beats parsing the inline `max-width`, which only exists under the
 * default `useMaxWidth:true`; the viewBox is there either way.
 *
 * Returning null is a real outcome, not a defensive gesture: `infoDiagram` calls
 * `configureSvgSize(svg, 100, 400, true)` and never sets a viewBox at all. Under
 * `useMaxWidth:true` that writes only `style="max-width:400px"` — the height is
 * discarded — and the node is still detached when frameDiagram() runs, so there
 * is no layout to recover an aspect ratio from. Half a size is not a size, so we
 * report null and the caller leaves the chart out of zooming entirely.
 */
function naturalSize(svg: SVGSVGElement): { w: number; h: number } | null {
  // Present but zeroed when the attribute is absent, hence the > 0 test.
  const vb = svg.viewBox.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height };

  // `useMaxWidth:false` shape: real width/height attributes instead of a style.
  // Percentages are the `useMaxWidth:true` shape (width="100%") and must not be
  // parsed — parseFloat("100%") would happily yield 100.
  const wAttr = svg.getAttribute("width") ?? "";
  const hAttr = svg.getAttribute("height") ?? "";
  if (!wAttr.includes("%") && !hAttr.includes("%")) {
    const w = parseFloat(wAttr);
    const h = parseFloat(hAttr);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
  }
  return null;
}

// ---- Public: framing / solo / popover teardown -----------------------------

/**
 * Wrap a freshly rendered `.mermaid-diagram` in the frame that carries its
 * toolbar, and stamp its natural size.
 *
 * The wrapper exists because the toolbar cannot live inside `.mermaid-diagram`:
 * zooming turns that node into an `overflow:auto` scroll container, and an
 * absolutely-positioned descendant of a scroll container scrolls with the
 * content — the toolbar would slide away the moment you panned. As a bonus, the
 * pan handler finds its target with `closest(".mermaid-diagram")`, so a toolbar
 * that is a *sibling* of the scroller rather than a descendant can't start a pan:
 * no stopPropagation gymnastics needed.
 *
 * Re-stamping `--mmd-nw`/`--mmd-nh` here on every render is what keeps a zoomed
 * chart alive across a keystroke: the re-render hands us a brand-new node while
 * `.mmd-zoomed` survives on the host, and a node without the variables would
 * either fall back to `width:auto` (zoom silently ignored) or, with a
 * "defensive" `var(--mmd-nw, 0)`, compute to width:0 and vanish.
 */
export function frameDiagram(diagram: HTMLElement): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "mermaid-frame";
  const svg = diagram.querySelector("svg");
  if (svg) {
    const n = naturalSize(svg);
    if (n) {
      diagram.style.setProperty("--mmd-nw", String(n.w));
      diagram.style.setProperty("--mmd-nh", String(n.h));
      // The gate CSS keys off: only charts with a known size may be zoomed.
      diagram.classList.add("mmd-sized");
    }
  }
  frame.append(diagram, buildToolbar());
  return frame;
}

/** Full-bleed the pane for a document that *is* one diagram, dropping the
 *  readable Markdown column. Lives on `#preview-host` rather than `.md-body`
 *  because ensureMdBody() reuses its node and only assigns className at
 *  creation — the class would never come back off, leaving Markdown clipped by
 *  `overflow:hidden` with no scrollbar. Call unconditionally on every render, not
 *  just when turning it on. */
export function setSoloMode(on: boolean): void {
  hostEl.classList.toggle("mmd-solo", on);
}

// ---- Toolbar ---------------------------------------------------------------

function toolbarButton(label: string, action: "transparent" | "color"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mmd-bg-btn";
  btn.dataset.mmdAction = action;
  btn.textContent = label;
  return btn;
}

function buildToolbar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "mmd-toolbar";
  bar.append(toolbarButton(LABEL_TRANSPARENT, "transparent"), toolbarButton(LABEL_COLOR, "color"));
  markActiveButtons(bar);
  return bar;
}

/** Mark whichever mode is live, so the pair reads as a two-way choice rather
 *  than two commands with no visible state. */
function markActiveButtons(root: ParentNode): void {
  const active = mermaidBgEnabled() ? "color" : "transparent";
  for (const b of root.querySelectorAll<HTMLElement>(".mmd-bg-btn")) {
    b.classList.toggle("mmd-active", b.dataset.mmdAction === active);
  }
}

/** Toolbars are built per render, but switching the backdrop deliberately does
 *  *not* re-render (that's the point of the CSS-variable design), so every
 *  already-visible toolbar would keep showing the old selection until the next
 *  keystroke happened to rebuild it. */
function refreshToolbarState(): void {
  if (hostEl) markActiveButtons(hostEl);
}

// ---- Zoom badge ------------------------------------------------------------

/**
 * A transient, centered readout of the preview scale on each zoom press.
 *
 * Mounted on document.body and fixed-positioned, never as a `#preview-host`
 * child: the first ensureMdBody() calls previewHost.replaceChildren(), which
 * would eat it. Later renders reuse `.md-body` and skip that path, so the bug
 * would only ever reproduce on the very first render of a session.
 */
let badgeEl: HTMLElement | null = null;
let badgeTimer: number | null = null;

function flashBadge(text: string): void {
  if (!badgeEl) {
    badgeEl = document.createElement("div");
    badgeEl.className = "mmd-badge";
    document.body.appendChild(badgeEl);
  }
  badgeEl.textContent = text;
  const r = hostEl.getBoundingClientRect();
  badgeEl.style.left = `${r.left + r.width / 2}px`;
  badgeEl.style.top = `${r.top + 16}px`;
  badgeEl.classList.add("visible");
  if (badgeTimer !== null) clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(() => {
    badgeEl?.classList.remove("visible");
    badgeTimer = null;
  }, 900);
}

// ---- Zoom routing ----------------------------------------------------------

/** Set by preview.ts (mountPreview) to size the Markdown text alongside the
 *  Mermaid scale. Kept as a callback rather than an import so mermaid-view stays
 *  free of a preview.ts dependency (preview → mermaid-view is the one direction). */
let onPreviewZoom: (() => void) | null = null;

export function setPreviewZoomHandler(fn: () => void): void {
  onPreviewZoom = fn;
}

/**
 * Apply a zoom command forwarded by the host.
 *
 * The badge re-flashes even when the value is unchanged (a press at the 400%
 * ceiling): the command was consumed, so it has to look consumed. In the app this
 * function also had to answer "was this mine?" so the caller could fall back to
 * the editor font — here the `activeWebviewPanelId` gate on the keybindings has
 * already made that call, so there is no fallback and no return value.
 *
 * @param dir 1 = in, -1 = out, 0 = reset to 100%.
 */
export function handleZoom(dir: 1 | -1 | 0): void {
  setZoomExp(dir === 0 ? 0 : Math.max(EXP_MIN, Math.min(EXP_MAX, zoomExp() + dir)));
  // Scale both the diagrams and the Markdown text from the new exponent.
  applyMermaidZoom();
  onPreviewZoom?.();
  flashBadge(`${Math.round(previewZoomFactor() * 100)}%`);
}

// ---- Backdrop popover ------------------------------------------------------

/**
 * Single-popover invariant, held in a module variable. The anchor is a chart
 * toolbar and can sit anywhere in the pane, so placement needs a flip and a clamp
 * on both axes rather than the one-axis clamp a bottom-edge anchor would need.
 */
let closePopover: (() => void) | null = null;

/** Close any open backdrop popover. Called from renderNow() because a re-render
 *  destroys the anchor underneath it. */
export function closeMermaidPopover(): void {
  closePopover?.();
}

function sliderRow(
  label: string,
  max: number,
  value: number,
  format: (v: number) => string,
  onInput: (v: number) => void,
): HTMLElement {
  const row = document.createElement("label");
  row.className = "mmd-row";
  const name = document.createElement("span");
  name.className = "mmd-row-label";
  name.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = String(max);
  input.value = String(value);
  const out = document.createElement("span");
  out.className = "mmd-row-value";
  out.textContent = format(value);
  // "input", not "change": change fires once on release, which would make the
  // sliders feel like a form rather than a live control.
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onInput(v);
  });
  row.append(name, input, out);
  return row;
}

function openBgPopover(anchor: HTMLElement): void {
  closePopover?.();

  const pop = document.createElement("div");
  pop.className = "mmd-popover";

  let bg = mermaidBg();
  const swatch = document.createElement("div");
  swatch.className = "mmd-swatch";

  // The popover is only reachable via the backdrop button, which turns the
  // backdrop on first, so the swatch always previews the live paint.
  const paint = (): void => {
    swatch.style.setProperty("--mmd-swatch", bgCss(bg, true));
    applyMermaidBg();
  };

  const commit = (next: Partial<MermaidBg>): void => {
    bg = { ...bg, ...next };
    setMermaidBg(bg);
    paint();
  };

  pop.append(
    swatch,
    sliderRow("R", 255, bg.r, String, (v) => commit({ r: v })),
    sliderRow("G", 255, bg.g, String, (v) => commit({ g: v })),
    sliderRow("B", 255, bg.b, String, (v) => commit({ b: v })),
    sliderRow(LABEL_OPACITY, 100, Math.round(bg.a * 100), (v) => `${v}%`, (v) => commit({ a: v / 100 })),
  );
  document.body.appendChild(pop);
  paint();

  // Flip and clamp on both axes: this anchor can sit anywhere in the pane, so
  // either edge may be the one that runs out.
  const a = anchor.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(4, Math.min(a.right - p.width, vw - p.width - 4));
  let top = a.bottom + 4;
  if (top + p.height > vh - 4) top = a.top - p.height - 4; // flip above
  top = Math.max(4, Math.min(top, vh - p.height - 4));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  const onDocDown = (e: MouseEvent): void => {
    if (!pop.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  function close(): void {
    pop.remove();
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onKey, true);
    closePopover = null;
  }
  // Deferred so the click that opened this doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  closePopover = close;
}

// ---- Pan drag --------------------------------------------------------------

/**
 * Pointer capture plus a body userSelect lock, with pointercancel wired to the
 * same teardown as pointerup. Without that last part, an OS-cancelled pointer
 * strands `document.body.style.userSelect` at "none" and text selection dies
 * pane-wide, with nothing on screen to explain why.
 */
let panning: {
  el: HTMLElement;
  x: number;
  y: number;
  left: number;
  top: number;
  id: number;
} | null = null;

function onPanDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const el = (e.target as Element | null)?.closest<HTMLElement>(".mermaid-diagram");
  if (!el) return;
  // Nothing to pan → leave the event alone, so text selection and clicks on
  // diagram labels keep working at 100%.
  if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
  panning = {
    el,
    x: e.clientX,
    y: e.clientY,
    left: el.scrollLeft,
    top: el.scrollTop,
    id: e.pointerId,
  };
  el.classList.add("mmd-panning");
  document.body.style.userSelect = "none";
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* capture is an optimization here; document-level listeners carry the drag */
  }
  e.preventDefault();
}

function onPanMove(e: PointerEvent): void {
  if (!panning) return;
  panning.el.scrollLeft = panning.left - (e.clientX - panning.x);
  panning.el.scrollTop = panning.top - (e.clientY - panning.y);
}

function onPanUp(): void {
  if (!panning) return;
  const { el, id } = panning;
  panning = null;
  el.classList.remove("mmd-panning");
  document.body.style.userSelect = "";
  try {
    el.releasePointerCapture(id);
  } catch {
    /* already released, or the node was replaced by a re-render mid-drag */
  }
}

// ---- Mount -----------------------------------------------------------------

function onHostClick(e: MouseEvent): void {
  const btn = (e.target as Element | null)?.closest<HTMLElement>(".mmd-bg-btn");
  if (!btn) return;
  if (btn.dataset.mmdAction === "transparent") {
    // Flips the switch without touching the stored rgba, so coming back to the
    // backdrop button restores the color the user picked rather than a default.
    setMermaidBgEnabled(false);
    applyMermaidBg();
    closeMermaidPopover();
    return;
  }
  // Turn the backdrop on before opening, or the sliders would edit a color that
  // isn't being painted and the popover would look broken.
  setMermaidBgEnabled(true);
  applyMermaidBg();
  openBgPopover(btn);
}

/**
 * Wire the diagram viewport to `#preview-host`. Call once, from mountPreview().
 *
 * Every listener is delegated to the host (or to document) rather than attached
 * per chart: charts are rebuilt on a 200ms debounce, so per-chart listeners would
 * be re-registered dozens of times during ordinary typing. Toolbar *elements* are
 * still built per chart — they die with their frame, so they can't be orphaned.
 * pointermove/up go on document because the captured node can be deleted by a
 * re-render mid-drag.
 */
export function mountMermaidView(host: HTMLElement): void {
  hostEl = host;
  // Seed the variables so the stylesheet has real values from the first paint.
  // Both apply* helpers are badge-free by construction, so nothing flashes at
  // startup; flashBadge() is reachable only from handleZoom().
  applyMermaidBg();
  applyMermaidZoom();
  host.addEventListener("click", onHostClick);
  host.addEventListener("pointerdown", onPanDown);
  document.addEventListener("pointermove", onPanMove);
  document.addEventListener("pointerup", onPanUp);
  document.addEventListener("pointercancel", onPanUp);
}
