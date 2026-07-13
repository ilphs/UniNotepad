import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting, StreamLanguage } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { java } from "@codemirror/lang-java";
import { python } from "@codemirror/lang-python";
import { shell } from "@codemirror/legacy-modes/mode/shell";

/**
 * Theme-aware highlight style. Colors are CSS variables (defined in styles.css
 * per light/dark) so highlighting stays readable in both themes with a single
 * style definition.
 */
const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--cm-keyword)" },
  { tag: [t.string, t.special(t.string), t.character], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--cm-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--cm-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--cm-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--cm-property)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--cm-operator)" },
  { tag: [t.definition(t.variableName), t.variableName], color: "var(--cm-variable)" },
  { tag: [t.regexp, t.escape], color: "var(--cm-string)" },
  { tag: t.invalid, color: "var(--cm-invalid)" },
]);

/** Included once in every editor state; harmless when a tab has no language. */
export const highlighting: Extension = syntaxHighlighting(highlightStyle, { fallback: true });

/** Resolve a file path to its language extension (empty for plain text). */
export function languageForPath(path: string | null): Extension {
  if (!path) return [];
  const ext = path.split(/[\\/]/).pop()!.split(".").pop()!.toLowerCase();
  switch (ext) {
    case "json":
      return json();
    case "sql":
      return sql();
    case "java":
      return java();
    case "py":
      return python();
    case "sh":
    case "bash":
      return StreamLanguage.define(shell);
    // "txt" and everything else: plain text, no highlighting.
    default:
      return [];
  }
}
