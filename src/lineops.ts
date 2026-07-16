/**
 * Line operations (Notepad++ "Edit ▸ Line Operations" style). Each command
 * rewrites whole lines via a single CodeMirror transaction, so undo/redo covers
 * it in one step. The target is the lines touched by the selection, or the whole
 * document when the selection is empty. All are pure CM6 — no new dependencies.
 */
import type { EditorView } from "@codemirror/view";
import { moveLineUp as cmMoveLineUp, moveLineDown as cmMoveLineDown } from "@codemirror/commands";
import { getView } from "./editor";

/** The [from, to] document range spanning every line the selection touches, or
 *  the whole document when nothing is selected. Returns null for an empty doc. */
function targetRange(view: EditorView): { from: number; to: number } | null {
  const { state } = view;
  if (state.doc.length === 0) return null;
  const sel = state.selection.main;
  if (sel.empty) return { from: 0, to: state.doc.length };
  const from = state.doc.lineAt(sel.from).from;
  const to = state.doc.lineAt(sel.to).to;
  return { from, to };
}

/** Apply a whole-lines transform over the target range as one transaction. */
function transformLines(view: EditorView, fn: (lines: string[]) => string[]): void {
  const range = targetRange(view);
  if (!range) return;
  const text = view.state.sliceDoc(range.from, range.to);
  const lines = text.split("\n");
  const out = fn(lines).join("\n");
  if (out === text) return; // no-op → no history entry, no cursor jump
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: out },
    scrollIntoView: true,
  });
  view.focus();
}

/** Locale-aware line comparison, used by both sort directions. */
function byLocale(a: string, b: string): number {
  return a.localeCompare(b);
}

export function sortLinesAsc(): void {
  transformLines(getView(), (lines) => [...lines].sort(byLocale));
}

export function sortLinesDesc(): void {
  transformLines(getView(), (lines) => [...lines].sort((a, b) => byLocale(b, a)));
}

export function removeDuplicateLines(): void {
  transformLines(getView(), (lines) => {
    const seen = new Set<string>();
    return lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  });
}

export function removeEmptyLines(): void {
  transformLines(getView(), (lines) => lines.filter((l) => l.trim() !== ""));
}

export function trimTrailingWhitespace(): void {
  transformLines(getView(), (lines) => lines.map((l) => l.replace(/[ \t]+$/, "")));
}

export function toUpperCase(): void {
  transformLines(getView(), (lines) => lines.map((l) => l.toUpperCase()));
}

export function toLowerCase(): void {
  transformLines(getView(), (lines) => lines.map((l) => l.toLowerCase()));
}

/** Move the selected line(s) up/down — delegates to CodeMirror's own commands,
 *  which already preserve selection and history correctly. */
export function moveLineUp(): void {
  cmMoveLineUp(getView());
}

export function moveLineDown(): void {
  cmMoveLineDown(getView());
}
