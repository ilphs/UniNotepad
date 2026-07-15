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
