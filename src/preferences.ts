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
} from "./settings";
import {
  applyFontFamily,
  setEditorFontSizePx,
  applyGutter,
  applyWrap,
  applyWhitespace,
  applyIndent,
} from "./editor";
import { setTheme, themeChoice } from "./theme";

/** Font-size input bounds — mirror settings.ts's persisted zoom range. */
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 40;

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

/** A labeled number input row (`.field-row`), clamped to [min, max] on commit. */
function numberRow(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (v: number) => void,
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
    input.value = String(clamped);
    onChange(clamped);
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
  ]);

  // ---- Files ----
  section(box, "Files", [
    checkboxRow("Trim trailing whitespace on save", trimTrailingOnSave(), setTrimTrailingOnSave),
    checkboxRow("Ensure final newline on save", ensureFinalNewline(), setEnsureFinalNewline),
  ]);

  // ---- Appearance ----
  const themeOptions: SelectOption[] = [
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
    { label: "System", value: "system" },
  ];
  section(box, "Appearance", [
    selectRow("Theme", themeOptions, themeChoice(), (v) =>
      setTheme(v as "light" | "dark" | "system"),
    ),
  ]);

  const row = document.createElement("div");
  row.className = "modal-actions";
  const done = document.createElement("button");
  done.className = "primary";
  done.textContent = "Done";
  done.addEventListener("click", () => handle.close());
  row.appendChild(done);
  box.appendChild(row);
}
