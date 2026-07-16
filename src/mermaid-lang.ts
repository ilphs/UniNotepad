/**
 * Mermaid highlighting as a CodeMirror StreamLanguage.
 *
 * Hand-written because no Mermaid grammar ships with @codemirror/language-data
 * or @codemirror/legacy-modes — the `mermaid` dependency is the preview
 * renderer, not a parser. Only standard tag names are emitted: the shared
 * HighlightStyle (language.ts) styles those, and silently leaves anything else
 * unstyled.
 */
import type { StreamParser } from "@codemirror/language";

/** Diagram/section keywords, matched lowercased — mermaid accepts `note` and
 *  `Note`, `end` and `End`, alike. */
const KEYWORDS = new Set([
  "graph",
  "flowchart",
  "sequencediagram",
  "classdiagram",
  "statediagram",
  "statediagram-v2",
  "erdiagram",
  "gantt",
  "pie",
  "journey",
  "mindmap",
  "subgraph",
  "end",
  "participant",
  "note",
  "loop",
  "alt",
  "else",
  "opt",
  "par",
  "section",
  "title",
  "direction",
]);

/** Flow directions (`graph TD`). Case-sensitive, so a node named `lr` stays a node. */
const DIRECTIONS = new Set(["TD", "TB", "LR", "RL", "BT"]);

/** Links/arrows. Alternation is leftmost-wins, not longest-wins, so the longer
 *  forms have to come first or `-->` would tokenize as `--` plus a stray `>`. */
const LINK =
  /^(?:<-->|<==>|-\.+->|-\.+-|<--+|<==+|--+>>|--+[>xo]|--+|==+[>xo]|==+|~~~+|->>|->|:::)/;

/** Node/keyword word. Hyphens only join word characters, so `A-->B` yields the
 *  node `A` (not `A--`) while `stateDiagram-v2` stays one token. */
const WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*/;

export const mermaidMode: StreamParser<unknown> = {
  name: "mermaid",
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;

    // `%%` runs to end of line; that also swallows `%%{init: …}%%` directives.
    if (stream.match("%%")) {
      stream.skipToEnd();
      return "comment";
    }

    // Quoted label. Unterminated quotes end at the line break (mermaid has no
    // multi-line strings), which keeps the mode stateless.
    if (stream.match('"')) {
      while (!stream.eol()) if (stream.next() === '"') break;
      return "string";
    }

    if (stream.match(LINK)) return "operator";
    if (stream.match(/^\d+(?:\.\d+)?/)) return "number";

    const word = stream.match(WORD) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      if (KEYWORDS.has(w.toLowerCase()) || DIRECTIONS.has(w)) return "keyword";
      return "variableName";
    }

    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "%%" } },
};
