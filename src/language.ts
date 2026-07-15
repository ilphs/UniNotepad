import type { Extension } from "@codemirror/state";
import {
  HighlightStyle,
  syntaxHighlighting,
  StreamLanguage,
  LanguageDescription,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { java } from "@codemirror/lang-java";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { go } from "@codemirror/legacy-modes/mode/go";

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
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--cm-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--cm-property)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--cm-operator)" },
  { tag: [t.definition(t.variableName), t.variableName], color: "var(--cm-variable)" },
  { tag: [t.regexp, t.escape], color: "var(--cm-string)" },
  { tag: t.invalid, color: "var(--cm-invalid)" },
]);

/** Included once in every editor state; harmless when a tab has no language. */
export const highlighting: Extension = syntaxHighlighting(highlightStyle, { fallback: true });

/** Lowercased file extension of a path, or "" for none/untitled. */
function extOf(path: string | null): string {
  if (!path) return "";
  return path.split(/[\\/]/).pop()!.split(".").pop()!.toLowerCase();
}

/** True when the path is a Markdown document (drives the preview pane). */
export function isMarkdownPath(path: string | null): boolean {
  const ext = extOf(path);
  return ext === "md" || ext === "markdown";
}

/** Resolve a file path to its language extension (empty for plain text). */
export function languageForPath(path: string | null): Extension {
  if (!path) return [];
  const ext = extOf(path);
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
    case "html":
    case "htm":
    case "xhtml":
      return html();
    case "css":
      return css();
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "md":
    case "markdown":
      return markdown();
    case "xml":
      return xml();
    case "yml":
    case "yaml":
      return yaml();
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return cpp();
    case "rs":
      return rust();
    case "go":
      return StreamLanguage.define(go);
    // "txt" and everything else: fall through to the lazy language-data path
    // (loadLanguageFor) for broad, Notepad++-level extension coverage.
    default:
      return [];
  }
}

/** Loaded LanguageSupport cached by language name, so re-activating a tab
 *  reuses the same extension instance instead of re-importing. */
const langCache = new Map<string, Extension>();

/**
 * Resolve a language via `@codemirror/language-data` for extensions the static
 * fast-path (languageForPath) doesn't cover. Matches on the full basename, so
 * extensionless files like `Dockerfile`/`Makefile`/`CMakeLists.txt` work too.
 * Returns null when nothing matches. The import is dynamic (lazy) — each matched
 * language ships as its own chunk, loaded only when such a file is opened.
 */
export async function loadLanguageFor(path: string | null): Promise<Extension | null> {
  if (!path) return null;
  const base = path.split(/[\\/]/).pop() ?? "";
  const desc = LanguageDescription.matchFilename(languages, base);
  if (!desc) return null;
  const cached = langCache.get(desc.name);
  if (cached) return cached;
  try {
    const support = await desc.load();
    langCache.set(desc.name, support);
    return support;
  } catch {
    return null; // a language pack failed to load; leave the doc as plain text
  }
}
