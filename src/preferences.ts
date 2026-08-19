/**
 * Unified Preferences modal: a single, one-page dialog that applies every
 * change immediately (no Apply button — only Done, which just closes). Built on
 * the shared modal scaffolding and the reusable checkbox/select rows so the
 * old per-feature dialogs collapse into one surface.
 *
 * The old "Save Options…" dialog is gone; its two toggles live in the Files
 * section here.
 */
import { openModal, checkboxRow, selectRow, type SelectOption } from "./modal";
import {
  fontCandidates,
  editorFontFamily,
  setEditorFontFamily,
  editorFontSize,
  showLineNumbers,
  setShowLineNumbers,
  isWordWrap,
  setWordWrap,
  isShowWhitespace,
  setShowWhitespace,
  indentUseTabs,
  setIndentUseTabs,
  indentWidth,
  setIndentWidth,
  trimTrailingOnSave,
  setTrimTrailingOnSave,
  ensureFinalNewline,
  setEnsureFinalNewline,
  previewContentWidth,
  setPreviewContentWidth,
  pasteHtmlAsMarkdown,
  setPasteHtmlAsMarkdown,
} from "./settings";
import { refreshPreviewContentWidth } from "./preview";
import {
  applyFontFamily,
  setEditorFontSizePx,
  applyGutter,
  applyWrap,
  applyWhitespace,
  applyIndent,
} from "./editor";
import { setThemeFamily, setThemeMode, themeFamily, themeMode } from "./theme";
import { isThemeFamily, isThemeMode, THEMES } from "./themes";

/** Font-size input bounds — mirror settings.ts's persisted zoom range. */
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 40;

/** Preview text-column bounds — mirror settings.ts. The input's own floor is 0
 *  (the "no cap" value); PREVIEW_WIDTH_MIN is applied by the normalizer below,
 *  which has to match `setPreviewContentWidth` exactly. */
const PREVIEW_WIDTH_MIN = 320;
const PREVIEW_WIDTH_MAX = 3000;

/** A section heading + its rows, appended to the modal box. */
function section(box: HTMLElement, title: string, rows: HTMLElement[]): void {
  const wrap = document.createElement("div");
  wrap.className = "pref-section";
  const h = document.createElement("p");
  h.className = "pref-heading";
  h.textContent = title;
  wrap.appendChild(h);
  for (const r of rows) wrap.appendChild(r);
  box.appendChild(wrap);
}

/**
 * A labeled number input row (`.field-row`), clamped to [min, max] on commit.
 *
 * `normalize` runs after that clamp, for settings whose accepted values aren't a
 * plain range — the preview width takes 0 ("no cap") *or* 320+, with nothing in
 * between. It must return exactly what the setter will store, because the input
 * is rewritten to its result: without that the field would keep showing a value
 * the setting silently rejected.
 */
function numberRow(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (v: number) => void,
  normalize?: (v: number) => number,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field-row";
  const text = document.createElement("span");
  text.className = "field-label";
  text.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.value = String(value);
  const commit = (): void => {
    const n = Number(input.value);
    if (!Number.isFinite(n)) {
      input.value = String(value);
      return;
    }
    const clamped = Math.max(min, Math.min(max, Math.round(n)));
    const next = normalize ? normalize(clamped) : clamped;
    input.value = String(next);
    onChange(next);
  };
  input.addEventListener("change", commit);
  wrap.append(text, input);
  return wrap;
}

/** A two-option radio row (Spaces / Tabs) for the indent kind. */
function indentKindRow(useTabs: boolean, onChange: (tabs: boolean) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "field-row";
  const text = document.createElement("span");
  text.className = "field-label";
  text.textContent = "Indent using";
  const group = document.createElement("div");
  group.className = "radio-group";
  const make = (optLabel: string, tabs: boolean): HTMLElement => {
    const l = document.createElement("label");
    l.className = "radio-option";
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "pref-indent-kind";
    r.checked = tabs === useTabs;
    r.addEventListener("change", () => {
      if (r.checked) onChange(tabs);
    });
    const s = document.createElement("span");
    s.textContent = optLabel;
    l.append(r, s);
    return l;
  };
  group.append(make("Spaces", false), make("Tabs", true));
  wrap.append(text, group);
  return wrap;
}

/** The font-family options actually offered: the curated list minus any font
 *  the platform reports as not installed. System Default (empty value) always
 *  stays, and a stale-but-selected value is kept so the select never blanks. */
function fontOptions(): SelectOption[] {
  const current = editorFontFamily();
  return fontCandidates()
    .filter(
      (f) => f.value === "" || f.value === current || document.fonts.check(`12px "${f.value}"`),
    )
    .map((f) => ({ label: f.label, value: f.value }));
}

/** Open the single-page Preferences modal. */
export function openPreferences(): void {
  const handle = openModal({ ariaLabel: "Preferences", onCancel: () => handle.close() });
  const box = handle.box;
  box.classList.add("preferences");

  const title = document.createElement("p");
  title.textContent = "Preferences";
  box.appendChild(title);

  // ---- Editor ----
  const indentWidthOptions: SelectOption[] = Array.from({ length: 8 }, (_, i) => ({
    label: String(i + 1),
    value: String(i + 1),
  }));
  section(box, "Editor", [
    selectRow("Font family", fontOptions(), editorFontFamily(), (v) => {
      setEditorFontFamily(v);
      applyFontFamily();
    }),
    numberRow("Font size", editorFontSize(), FONT_SIZE_MIN, FONT_SIZE_MAX, (v) =>
      setEditorFontSizePx(v),
    ),
    checkboxRow("Show line numbers", showLineNumbers(), (v) => {
      setShowLineNumbers(v);
      applyGutter();
    }),
    checkboxRow("Word wrap", isWordWrap(), (v) => {
      setWordWrap(v);
      applyWrap();
    }),
    checkboxRow("Show whitespace", isShowWhitespace(), (v) => {
      setShowWhitespace(v);
      applyWhitespace();
    }),
    indentKindRow(indentUseTabs(), (tabs) => {
      setIndentUseTabs(tabs);
      applyIndent();
    }),
    selectRow("Indent width", indentWidthOptions, String(indentWidth()), (v) => {
      setIndentWidth(Number(v));
      applyIndent();
    }),
    // Markdown tabs only — the label says so, because the setting is global and
    // its effect would otherwise look inconsistent from a code tab.
    checkboxRow(
      "Paste HTML as Markdown (Markdown tabs)",
      pasteHtmlAsMarkdown(),
      setPasteHtmlAsMarkdown,
    ),
  ]);

  // ---- Files ----
  section(box, "Files", [
    checkboxRow("Trim trailing whitespace on save", trimTrailingOnSave(), setTrimTrailingOnSave),
    checkboxRow("Ensure final newline on save", ensureFinalNewline(), setEnsureFinalNewline),
  ]);

  // ---- Preview ----
  section(box, "Preview", [
    numberRow(
      "Text width (px, 0 = fill pane)",
      previewContentWidth(),
      0,
      PREVIEW_WIDTH_MAX,
      (v) => {
        setPreviewContentWidth(v);
        refreshPreviewContentWidth();
      },
      (v) => (v <= 0 ? 0 : Math.max(PREVIEW_WIDTH_MIN, v)),
    ),
  ]);

  // ---- Appearance ----
  // Two independent axes: which palette (Theme) and how light it is
  // (Appearance). Both mirror the native View → Theme submenu; the setters push
  // the new value back to the menu so the two views never drift.
  const themeOptions: SelectOption[] = THEMES.map((t) => ({
    label: t.label,
    value: t.id,
  }));
  const modeOptions: SelectOption[] = [
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
    { label: "System", value: "system" },
  ];
  // The guards are belt-and-braces: the <select> can only yield values we put
  // in it, but they narrow the string back to the union the setters expect.
  const familyRow = selectRow("Theme", themeOptions, themeFamily(), (v) => {
    if (isThemeFamily(v)) setThemeFamily(v);
  });
  const modeRow = selectRow("Appearance", modeOptions, themeMode(), (v) => {
    if (isThemeMode(v)) setThemeMode(v);
  });
  section(box, "Appearance", [familyRow, modeRow]);

  // selectRow snapshots its value at build time, but this modal is not the only
  // way to change a theme: the native View → Theme submenu stays live while an
  // HTML modal is up, so a menu pick would leave these two dropdowns showing
  // stale labels. Follow the same event the preview listens to.
  //
  // Self-unsubscribing on the first event after the modal is gone: openModal
  // exposes no close hook, and the rows leave the document when it closes, so
  // isConnected is the cheapest reliable liveness test.
  const syncSelects = (): void => {
    if (!familyRow.isConnected) {
      window.removeEventListener("uninotepad:themechange", syncSelects);
      return;
    }
    const fam = familyRow.querySelector("select");
    const mode = modeRow.querySelector("select");
    if (fam) fam.value = themeFamily();
    if (mode) mode.value = themeMode();
  };
  window.addEventListener("uninotepad:themechange", syncSelects);

  const row = document.createElement("div");
  row.className = "modal-actions";
  const done = document.createElement("button");
  done.className = "primary";
  done.textContent = "Done";
  done.addEventListener("click", () => handle.close());
  row.appendChild(done);
  box.appendChild(row);
}
