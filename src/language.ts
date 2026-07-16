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
import { mermaidMode } from "./mermaid-lang";
import type { Tab, FileTypeId } from "./state";

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

/**
 * Extension → file type. The single mapping table: both the picker's detection
 * and the static highlighting fast-path read it, so a language can't drift into
 * being offered in one place and unknown in the other. Anything absent is
 * "normal", which leaves it to the lazy language-data path (loadLanguageFor).
 */
const EXT_TO_TYPE: Record<string, FileTypeId> = {
  json: "json",
  sql: "sql",
  java: "java",
  py: "python",
  sh: "shell",
  bash: "shell",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  md: "markdown",
  markdown: "markdown",
  mmd: "mermaid",
  mermaid: "mermaid",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  rs: "rust",
  go: "go",
};

/** The type a path implies on its own, before any explicit pick. */
export function detectFileType(path: string | null): FileTypeId {
  return EXT_TO_TYPE[extOf(path)] ?? "normal";
}

/** The type in force for a tab: the user's explicit pick, else the extension. */
export function effectiveFileType(tab: Tab | null): FileTypeId {
  if (!tab) return "normal";
  return tab.fileType ?? detectFileType(tab.path);
}

/** Resolve a type to its language extension. `path` only refines a type it
 *  can't change (JSX/TSX dialects), so an explicit pick still wins.
 *
 *  "normal" is plain text — picking it is how the user turns highlighting and
 *  the preview off. Detection also lands here for unmapped extensions, but that
 *  leaves `fileType` null, which is what lets `applyLazyLanguage` still reach
 *  the lazy language-data path for them. */
export function languageForFileType(ft: FileTypeId, path: string | null): Extension {
  switch (ft) {
    case "markdown":
      return markdown();
    case "mermaid":
      return StreamLanguage.define(mermaidMode);
    case "json":
      return json();
    case "sql":
      return sql();
    case "java":
      return java();
    case "python":
      return python();
    case "shell":
      return StreamLanguage.define(shell);
    case "html":
      return html();
    case "css":
      return css();
    case "javascript":
      return javascript({ jsx: extOf(path) === "jsx" });
    case "typescript":
      return javascript({ typescript: true, jsx: extOf(path) === "tsx" });
    case "xml":
      return xml();
    case "yaml":
      return yaml();
    case "cpp":
      return cpp();
    case "rust":
      return rust();
    case "go":
      return StreamLanguage.define(go);
    default:
      return [];
  }
}

/** Resolve a file path to its language extension (empty for plain text). "txt"
 *  and every other unmapped extension land on [], leaving them to the lazy
 *  language-data path (loadLanguageFor) for Notepad++-level coverage. */
export function languageForPath(path: string | null): Extension {
  if (!path) return [];
  return languageForFileType(detectFileType(path), path);
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
