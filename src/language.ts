import type { Extension } from "@codemirror/state";
import {
  HighlightStyle,
  syntaxHighlighting,
  StreamLanguage,
  LanguageDescription,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { mermaidMode } from "./mermaid-lang";
import type { Tab, FileTypeId } from "./state";

// NOTE: the per-language grammars (@codemirror/lang-*, legacy-modes shell/go)
// are intentionally NOT imported statically here — each ships its own Lezer
// grammar (~400 kB combined) and would land in the entry chunk. They load
// dynamically in buildFastPathLanguage() so opening a plain file pays nothing.
// Only mermaidMode (local), @codemirror/language, language-data and
// @lezer/highlight stay static.

/**
 * Theme-aware highlight style. Colors are CSS variables (defined in styles.css
 * per light/dark) so highlighting stays readable in both themes with a single
 * style definition. Exported so the Markdown preview can reuse the exact same
 * token→color mapping for its fenced code blocks (see preview.ts).
 */
export const highlightStyle = HighlightStyle.define([
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

/** True for every type the static-detection fast-path knows how to build a
 *  grammar for — i.e. everything except plain "normal". editor.ts routes these
 *  to loadFastPathLanguage; anything else (unmapped extensions) falls through to
 *  the lazy language-data path. */
export function isFastPathType(ft: FileTypeId): boolean {
  return ft !== "normal";
}

/** Cache key for a fast-path language. Includes the dialect for JS/TS because
 *  `javascript({ jsx })` / `javascript({ typescript, tsx })` are distinct
 *  configurations that must not share one cached instance — the no-op guard in
 *  editor.ts relies on "same key → same Extension instance". */
function fastPathKey(ft: FileTypeId, path: string | null): string | null {
  switch (ft) {
    case "normal":
      return null;
    case "javascript":
      return extOf(path) === "jsx" ? "javascript:jsx" : "javascript:plain";
    case "typescript":
      return extOf(path) === "tsx" ? "typescript:tsx" : "typescript:plain";
    default:
      return ft;
  }
}

/** Dynamically import and build the language extension for a fast-path type.
 *  Each grammar is its own async chunk, so only the ones actually opened load. */
async function buildFastPathLanguage(ft: FileTypeId, path: string | null): Promise<Extension | null> {
  switch (ft) {
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "mermaid":
      return StreamLanguage.define(mermaidMode);
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "shell":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: extOf(path) === "jsx" });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: extOf(path) === "tsx",
      });
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "go":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go);
    default:
      return null;
  }
}

/**
 * Resolve a fast-path type to its language extension, importing the grammar
 * lazily. `path` only refines a type it can't change (JSX/TSX dialects), so an
 * explicit pick still wins. Returns null for "normal" (plain text — no grammar).
 *
 * Cached by dialect-inclusive key, so re-activating a tab of the same type
 * reuses the exact same Extension instance. That identity is what lets
 * editor.ts skip a redundant reconfigure (and re-parse) on every tab switch.
 */
export async function loadFastPathLanguage(ft: FileTypeId, path: string | null): Promise<Extension | null> {
  const key = fastPathKey(ft, path);
  if (key === null) return null;
  const cached = langCache.get(key);
  if (cached) return cached;
  try {
    const ext = await buildFastPathLanguage(ft, path);
    if (ext) langCache.set(key, ext);
    return ext;
  } catch {
    return null; // a grammar chunk failed to load; leave the doc as plain text
  }
}

/** Loaded LanguageSupport cached by name (language-data path) and by
 *  dialect-inclusive key (fast-path), so re-activating a tab reuses the same
 *  extension instance instead of re-importing. Keys never collide: language-data
 *  names are capitalized ("JavaScript"), fast-path keys are lowercased ids. */
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
