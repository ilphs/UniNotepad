/**
 * Global editor preferences persisted in localStorage (same pattern as theme.ts).
 * These are app-wide toggles, not per-tab: word wrap and save-time text options.
 */

const WRAP_KEY = "uninotepad.wordWrap";
const TRIM_KEY = "uninotepad.trimTrailingOnSave";
const FINAL_NL_KEY = "uninotepad.ensureFinalNewline";
const PREVIEW_KEY = "uninotepad.markdownPreview";
const RATIO_KEY = "uninotepad.previewRatio";
const INDENT_TABS_KEY = "uninotepad.indentUseTabs";
const INDENT_WIDTH_KEY = "uninotepad.indentWidth";
const MERMAID_BG_KEY = "uninotepad.mermaidBg";
const MERMAID_BG_ON_KEY = "uninotepad.mermaidBgEnabled";

/** Indent width bounds (columns). */
const INDENT_WIDTH_MIN = 1;
const INDENT_WIDTH_MAX = 8;
const INDENT_WIDTH_DEFAULT = 4;

/** Editor:preview split bounds — keeps either pane from collapsing. */
const RATIO_MIN = 0.2;
const RATIO_MAX = 0.8;
const RATIO_DEFAULT = 0.5;

/** localStorage boolean with an explicit default when unset/invalid. */
function readBool(key: string, dflt: boolean): boolean {
  const v = localStorage.getItem(key);
  if (v === "true") return true;
  if (v === "false") return false;
  return dflt;
}

function writeBool(key: string, value: boolean): void {
  localStorage.setItem(key, value ? "true" : "false");
}

/** Word wrap defaults ON (matches the app's prior always-wrapped behavior). */
export function isWordWrap(): boolean {
  return readBool(WRAP_KEY, true);
}

export function setWordWrap(on: boolean): void {
  writeBool(WRAP_KEY, on);
}

/** Strip trailing whitespace from every line on save (default OFF). */
export function trimTrailingOnSave(): boolean {
  return readBool(TRIM_KEY, false);
}

export function setTrimTrailingOnSave(on: boolean): void {
  writeBool(TRIM_KEY, on);
}

/** Ensure the file ends with exactly one trailing newline on save (default OFF). */
export function ensureFinalNewline(): boolean {
  return readBool(FINAL_NL_KEY, false);
}

export function setEnsureFinalNewline(on: boolean): void {
  writeBool(FINAL_NL_KEY, on);
}

/** Markdown preview pane defaults ON — opening a Markdown file shows it
 *  automatically. Key kept as `markdownPreview` to preserve saved settings. */
export function isPreviewEnabled(): boolean {
  return readBool(PREVIEW_KEY, true);
}

export function setPreviewEnabled(on: boolean): void {
  writeBool(PREVIEW_KEY, on);
}

/** Editor's share of the split (0.2–0.8); the preview takes the remainder. */
export function previewRatio(): number {
  const v = Number(localStorage.getItem(RATIO_KEY));
  if (!Number.isFinite(v) || v <= 0) return RATIO_DEFAULT;
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, v));
}

export function setPreviewRatio(ratio: number): void {
  const clamped = Math.max(RATIO_MIN, Math.min(RATIO_MAX, ratio));
  localStorage.setItem(RATIO_KEY, String(clamped));
}

/** Backdrop painted behind every rendered Mermaid diagram: 8-bit RGB channels
 *  plus a 0–1 opacity. Consumed by mermaid-view.ts as an `--mmd-bg` rgba(). */
export interface MermaidBg {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** White at full opacity: the useful starting point, since the backdrop mainly
 *  exists to rescue a light diagram viewed under the dark theme. */
const MERMAID_BG_DEFAULT: MermaidBg = { r: 255, g: 255, b: 255, a: 1 };

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clampAlpha(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Whether the backdrop is painted at all. Kept separate from `a === 0` on
 *  purpose: folding "transparent" into the alpha would destroy the opacity the
 *  user picked every time they toggled the backdrop off and back on.
 *  Defaults OFF — that is the app's long-standing see-through behavior. */
export function mermaidBgEnabled(): boolean {
  return readBool(MERMAID_BG_ON_KEY, false);
}

export function setMermaidBgEnabled(on: boolean): void {
  writeBool(MERMAID_BG_ON_KEY, on);
}

/** The stored backdrop color, or the default if anything about the stored
 *  "r,g,b,a" is off. Falls back as a whole tuple rather than per channel: a
 *  half-parsed record would paint a color the user never chose. Note the
 *  `!raw` guard and the empty-part check exist because `Number(null)` and
 *  `Number("")` are both 0, which would silently read as a valid channel. */
export function mermaidBg(): MermaidBg {
  const raw = localStorage.getItem(MERMAID_BG_KEY);
  if (!raw) return { ...MERMAID_BG_DEFAULT };
  const parts = raw.split(",");
  if (parts.length !== 4) return { ...MERMAID_BG_DEFAULT };
  const n = parts.map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (n.some((v) => !Number.isFinite(v))) return { ...MERMAID_BG_DEFAULT };
  return { r: clampChannel(n[0]), g: clampChannel(n[1]), b: clampChannel(n[2]), a: clampAlpha(n[3]) };
}

export function setMermaidBg(bg: MermaidBg): void {
  const v = [clampChannel(bg.r), clampChannel(bg.g), clampChannel(bg.b), clampAlpha(bg.a)];
  localStorage.setItem(MERMAID_BG_KEY, v.join(","));
}

/** Indent with real tab characters instead of spaces (default OFF → spaces). */
export function indentUseTabs(): boolean {
  return readBool(INDENT_TABS_KEY, false);
}

export function setIndentUseTabs(on: boolean): void {
  writeBool(INDENT_TABS_KEY, on);
}

/** Indent width in columns (1–8, default 4). Also drives the Tab display size. */
export function indentWidth(): number {
  const v = Number(localStorage.getItem(INDENT_WIDTH_KEY));
  if (!Number.isInteger(v)) return INDENT_WIDTH_DEFAULT;
  return Math.max(INDENT_WIDTH_MIN, Math.min(INDENT_WIDTH_MAX, v));
}

export function setIndentWidth(width: number): void {
  const clamped = Math.max(INDENT_WIDTH_MIN, Math.min(INDENT_WIDTH_MAX, Math.round(width)));
  localStorage.setItem(INDENT_WIDTH_KEY, String(clamped));
}

/** The string inserted per indent level: a tab, or `indentWidth` spaces. */
export function indentUnitString(): string {
  return indentUseTabs() ? "\t" : " ".repeat(indentWidth());
}

/**
 * Apply the enabled save-time transforms to LF-normalized editor text.
 * Operates purely on the string handed to `save_file` (Rust re-applies EOL/BOM),
 * so the in-editor buffer is left untouched.
 */
export function applySaveOptions(text: string): string {
  let out = text;
  if (trimTrailingOnSave()) {
    // Remove spaces/tabs before each line end (buffer is always LF here).
    out = out.replace(/[ \t]+(\n|$)/g, "$1");
  }
  if (ensureFinalNewline()) {
    // Collapse trailing blank lines to a single newline; add one if missing.
    out = out.replace(/\n*$/, "\n");
    if (out === "\n") out = ""; // don't force a newline into an empty document
  }
  return out;
}
