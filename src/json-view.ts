/**
 * JSON preview: a lenient parser plus a collapsible tree renderer for the
 * preview pane (modelled on json.parser.online.fr).
 *
 * The parser deliberately accepts a superset of JSON — comments, trailing
 * commas, unquoted keys, single-quoted strings, hex/`+`-prefixed numbers,
 * `NaN`/`Infinity`/`undefined` — because real-world files (tsconfig-style
 * JSONC, hand-edited configs) routinely carry them and a preview that refuses
 * to draw them is useless exactly when you most want to look at the shape.
 *
 * It is a hand-written recursive-descent parser, NOT `eval`/`new Function`:
 *   - the app's CSP (`default-src 'self'`, see tauri.conf.json) has no
 *     'unsafe-eval', so eval would throw outright; and
 *   - files arrive from Finder double-clicks, file associations, CLI args and
 *     drag-and-drop, so evaluating their contents would turn "open a file" into
 *     "run that file's code" inside a webview holding Tauri IPC.
 * Parsing a superset gets the same leniency with none of that.
 *
 * Values keep their source order (entries are an array, not a JS object) so
 * integer-like keys don't get silently reordered the way `JSON.parse` output
 * would, and numbers keep their source text so `1e3`, `0x1f` and `-0` render
 * as written.
 */

// ---- Model -----------------------------------------------------------------

export interface JsonEntry {
  key: string;
  /** True when the key was written bare (`{a: 1}`) — a lenient-only form. */
  bareKey: boolean;
  value: JsonNode;
}

export type JsonNode =
  | { kind: "object"; entries: JsonEntry[] }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "string"; value: string }
  /** Number kept as source text: `1e3`/`0x1f`/`-0` should render as written. */
  | { kind: "number"; text: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  /** `undefined` / `NaN` / `Infinity` / `-Infinity` — lenient-only literals. */
  | { kind: "literal"; text: string };

export interface JsonParseError {
  message: string;
  /** 1-based, for display and for jumping the editor to the offending spot. */
  line: number;
  column: number;
}

export interface JsonParseResult {
  node: JsonNode | null;
  /** True when parsing had to reach past strict JSON to succeed. */
  lenient: boolean;
  /** Set when the document could not be parsed even leniently. */
  error: JsonParseError | null;
  /** Total nodes; drives the "expand everything?" decision in the renderer. */
  nodeCount: number;
}

// ---- Parser ----------------------------------------------------------------

/** Nesting cap. Deep input would otherwise blow the JS stack (and produce a
 *  tree no one can read anyway); 512 is far past any real document. */
const MAX_DEPTH = 512;

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Thrown internally; converted to a JsonParseError at the top level. */
class JsonSyntaxError extends Error {
  constructor(message: string, readonly index: number) {
    super(message);
  }
}

class Parser {
  private pos = 0;
  /** Set the moment any non-strict construct is consumed. */
  lenient = false;
  nodeCount = 0;

  constructor(private readonly src: string) {}

  parseDocument(): JsonNode {
    this.skipBlank();
    const node = this.parseValue(0);
    this.skipBlank();
    if (this.pos < this.src.length) this.fail(`Unexpected ${this.describeHere()} after the top-level value`);
    return node;
  }

  // -- helpers --

  private fail(message: string): never {
    throw new JsonSyntaxError(message, this.pos);
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  /** Human-readable name for what sits at the cursor, for error messages. */
  private describeHere(): string {
    if (this.pos >= this.src.length) return "end of input";
    return `'${this.src[this.pos]}'`;
  }

  /** Whitespace plus — leniently — `//` and `/* *​/` comments. */
  private skipBlank(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === " " || c === "﻿") {
        this.pos++;
        continue;
      }
      if (c === "/") {
        const next = this.src[this.pos + 1];
        if (next === "/") {
          this.lenient = true;
          this.pos += 2;
          while (this.pos < this.src.length && this.src[this.pos] !== "\n") this.pos++;
          continue;
        }
        if (next === "*") {
          this.lenient = true;
          this.pos += 2;
          const end = this.src.indexOf("*/", this.pos);
          if (end < 0) this.fail("Unterminated block comment");
          this.pos = end + 2;
          continue;
        }
      }
      return;
    }
  }

  // -- values --

  private parseValue(depth: number): JsonNode {
    if (depth > MAX_DEPTH) this.fail(`Nesting deeper than ${MAX_DEPTH} levels`);
    this.nodeCount++;
    const c = this.peek();
    switch (c) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return { kind: "string", value: this.parseString() };
      case "'":
        this.lenient = true;
        return { kind: "string", value: this.parseString() };
      case "":
        this.fail("Unexpected end of input");
    }
    if (c === "-" || c === "+" || c === "." || (c >= "0" && c <= "9")) return this.parseNumber();
    return this.parseWord();
  }

  private parseObject(depth: number): JsonNode {
    this.pos++; // '{'
    const entries: JsonEntry[] = [];
    this.skipBlank();
    if (this.peek() === "}") {
      this.pos++;
      return { kind: "object", entries };
    }
    for (;;) {
      this.skipBlank();
      // A trailing comma leaves us looking at the closing brace.
      if (this.peek() === "}") {
        this.pos++;
        return { kind: "object", entries };
      }
      const { key, bare } = this.parseKey();
      this.skipBlank();
      if (this.peek() !== ":") this.fail(`Expected ':' after the key, found ${this.describeHere()}`);
      this.pos++;
      this.skipBlank();
      const value = this.parseValue(depth + 1);
      entries.push({ key, bareKey: bare, value });
      this.skipBlank();
      const c = this.peek();
      if (c === ",") {
        this.pos++;
        // Only a *trailing* comma is lenient; the loop head decides which it was.
        this.skipBlank();
        if (this.peek() === "}") this.lenient = true;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return { kind: "object", entries };
      }
      this.fail(`Expected ',' or '}' in object, found ${this.describeHere()}`);
    }
  }

  private parseArray(depth: number): JsonNode {
    this.pos++; // '['
    const items: JsonNode[] = [];
    this.skipBlank();
    if (this.peek() === "]") {
      this.pos++;
      return { kind: "array", items };
    }
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") {
        this.pos++;
        return { kind: "array", items };
      }
      items.push(this.parseValue(depth + 1));
      this.skipBlank();
      const c = this.peek();
      if (c === ",") {
        this.pos++;
        this.skipBlank();
        if (this.peek() === "]") this.lenient = true;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return { kind: "array", items };
      }
      this.fail(`Expected ',' or ']' in array, found ${this.describeHere()}`);
    }
  }

  private parseKey(): { key: string; bare: boolean } {
    const c = this.peek();
    if (c === '"') return { key: this.parseString(), bare: false };
    if (c === "'") {
      this.lenient = true;
      return { key: this.parseString(), bare: false };
    }
    if (IDENT_START.test(c)) {
      const start = this.pos;
      while (this.pos < this.src.length && IDENT_PART.test(this.src[this.pos])) this.pos++;
      this.lenient = true;
      return { key: this.src.slice(start, this.pos), bare: true };
    }
    this.fail(`Expected a key, found ${this.describeHere()}`);
  }

  /** Quoted string; `quote` is whichever quote opened it. */
  private parseString(): string {
    const quote = this.src[this.pos];
    this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= this.src.length) this.fail("Unterminated string");
      const c = this.src[this.pos];
      if (c === quote) {
        this.pos++;
        return out;
      }
      if (c === "\n") this.fail("Unterminated string (line break inside a string)");
      if (c !== "\\") {
        out += c;
        this.pos++;
        continue;
      }
      this.pos++;
      const esc = this.src[this.pos];
      if (esc === undefined) this.fail("Unterminated escape sequence");
      this.pos++;
      switch (esc) {
        case '"':
        case "\\":
        case "/":
          out += esc;
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = this.src.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("Malformed \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        case "x": {
          // \xNN — JS-only.
          const hex = this.src.slice(this.pos, this.pos + 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail("Malformed \\x escape");
          this.lenient = true;
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 2;
          break;
        }
        case "\n":
          this.lenient = true; // line continuation
          break;
        default:
          // JS drops the backslash for any other escape; JSON rejects it.
          this.lenient = true;
          out += esc;
      }
    }
  }

  private parseNumber(): JsonNode {
    const start = this.pos;
    if (this.peek() === "+") {
      this.lenient = true;
      this.pos++;
    } else if (this.peek() === "-") {
      this.pos++;
    }
    // A signed `Infinity`/`NaN` is a number position holding a JS-only literal.
    if (IDENT_START.test(this.peek())) {
      const word = this.readWord();
      if (word === "Infinity" || word === "NaN") {
        this.lenient = true;
        return { kind: "literal", text: this.src.slice(start, this.pos) };
      }
      this.fail(`Unexpected '${word}' in a number`);
    }
    if (this.peek() === "0" && (this.src[this.pos + 1] === "x" || this.src[this.pos + 1] === "X")) {
      this.pos += 2;
      const digitsStart = this.pos;
      while (/[0-9a-fA-F]/.test(this.peek())) this.pos++;
      if (this.pos === digitsStart) this.fail("Hex literal with no digits");
      this.lenient = true;
      return { kind: "number", text: this.src.slice(start, this.pos) };
    }
    const intStart = this.pos;
    while (this.peek() >= "0" && this.peek() <= "9") this.pos++;
    const hadInt = this.pos > intStart;
    // Leading zeros (`007`) are JS-legal-ish and JSON-illegal; flag them.
    if (hadInt && this.src[intStart] === "0" && this.pos - intStart > 1) this.lenient = true;
    if (!hadInt && this.peek() !== ".") this.fail(`Expected a number, found ${this.describeHere()}`);
    if (!hadInt) this.lenient = true; // `.5`
    if (this.peek() === ".") {
      this.pos++;
      const fracStart = this.pos;
      while (this.peek() >= "0" && this.peek() <= "9") this.pos++;
      if (this.pos === fracStart) this.lenient = true; // `5.`
    }
    if (this.peek() === "e" || this.peek() === "E") {
      this.pos++;
      if (this.peek() === "+" || this.peek() === "-") this.pos++;
      const expStart = this.pos;
      while (this.peek() >= "0" && this.peek() <= "9") this.pos++;
      if (this.pos === expStart) this.fail("Exponent with no digits");
    }
    return { kind: "number", text: this.src.slice(start, this.pos) };
  }

  private readWord(): string {
    const start = this.pos;
    while (this.pos < this.src.length && IDENT_PART.test(this.src[this.pos])) this.pos++;
    return this.src.slice(start, this.pos);
  }

  /** A bare word in value position: `true`/`false`/`null`, or a JS-only literal. */
  private parseWord(): JsonNode {
    if (!IDENT_START.test(this.peek())) this.fail(`Unexpected ${this.describeHere()}`);
    const word = this.readWord();
    switch (word) {
      case "true":
        return { kind: "boolean", value: true };
      case "false":
        return { kind: "boolean", value: false };
      case "null":
        return { kind: "null" };
      case "undefined":
      case "NaN":
      case "Infinity":
        this.lenient = true;
        return { kind: "literal", text: word };
      default:
        this.fail(`Unexpected '${word}'`);
    }
  }
}

/** 1-based line/column for a source offset. */
function lineColumn(src: string, index: number): { line: number; column: number } {
  const upto = src.slice(0, index);
  const line = upto.split("\n").length;
  const column = index - (upto.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

/**
 * Parse a document, accepting the lenient superset described at the top of this
 * file. Never throws: a malformed document comes back with `node: null` and an
 * `error` carrying the position, which is what the pane draws instead of a tree.
 */
export function parseJsonDocument(src: string): JsonParseResult {
  const parser = new Parser(src);
  if (src.trim() === "") {
    return { node: null, lenient: false, error: { message: "Empty document", line: 1, column: 1 }, nodeCount: 0 };
  }
  try {
    const node = parser.parseDocument();
    return { node, lenient: parser.lenient, error: null, nodeCount: parser.nodeCount };
  } catch (err) {
    const index = err instanceof JsonSyntaxError ? err.index : 0;
    const message = err instanceof Error ? err.message : String(err);
    return { node: null, lenient: parser.lenient, error: { message, ...lineColumn(src, index) }, nodeCount: 0 };
  }
}

// ---- Tree rendering --------------------------------------------------------

/** Above this many nodes the tree opens only to AUTO_OPEN_DEPTH and renders
 *  deeper levels on demand, so a big file doesn't build a six-figure DOM up
 *  front. Below it everything is expanded and fully built — which also keeps
 *  "Export preview as HTML" faithful for documents of any ordinary size. */
const FULL_EXPAND_NODE_LIMIT = 5000;
const AUTO_OPEN_DEPTH = 2;

/**
 * Per-tab record of branches the user opened or closed by hand, keyed by node
 * path. It exists because every re-render rebuilds `.md-body` wholesale — the
 * Markdown path has no state to lose, but a tree would otherwise snap back to
 * its default shape on each keystroke.
 *
 * Both directions have to be stored, not just the closures: in a document big
 * enough to open only to AUTO_OPEN_DEPTH, a branch the user expanded past that
 * depth has no record to distinguish it from one they never touched, and the
 * next render would collapse it again.
 */
const openStateByTab = new Map<string, Map<string, boolean>>();

/** Drop a tab's remembered expand/collapse state when it closes. */
export function forgetJsonViewState(tabId: string): void {
  openStateByTab.delete(tabId);
}

export interface JsonTreeOptions {
  /** Identifies whose collapse state this is. */
  tabId: string;
  /** Jump the editor to a parse error's position. */
  onJump: (line: number, column: number) => void;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function childPath(parent: string, key: string | number): string {
  return typeof key === "number" ? `${parent}[${key}]` : `${parent}.${JSON.stringify(key)}`;
}

/** `3 items` / `1 item` — the summary shown in place of a collapsed body. */
function countLabel(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

function isContainer(node: JsonNode): node is Extract<JsonNode, { kind: "object" | "array" }> {
  return node.kind === "object" || node.kind === "array";
}

/** The coloured text of a leaf value. Classes map onto the editor's own
 *  `--cm-*` theme variables, so the tree follows every theme family and
 *  light/dark mode without any new colour definitions of its own. */
function leafValue(node: JsonNode): HTMLElement {
  switch (node.kind) {
    case "string":
      return el("span", "jt-string", JSON.stringify(node.value));
    case "number":
      return el("span", "jt-number", node.text);
    case "boolean":
      return el("span", "jt-boolean", String(node.value));
    case "null":
      return el("span", "jt-null", "null");
    case "literal":
      return el("span", "jt-literal", node.text);
    default:
      return el("span", "jt-null", "");
  }
}

/** Key (or array index) label that precedes a value. */
function labelFor(entry: { key: string; bareKey: boolean } | number | null): HTMLElement | null {
  if (entry === null) return null;
  if (typeof entry === "number") return el("span", "jt-index", String(entry));
  const span = el("span", "jt-key", entry.bareKey ? entry.key : JSON.stringify(entry.key));
  if (entry.bareKey) span.classList.add("jt-key-bare");
  return span;
}

interface RenderCtx {
  /** path → the user's explicit choice; absent means "use the default". */
  openState: Map<string, boolean>;
  fullExpand: boolean;
}

/**
 * One node → one DOM subtree. Containers become `<details>` so collapsing needs
 * no JavaScript at all: the exported HTML and the printed page keep working
 * exactly like the pane. `last` controls the trailing comma.
 */
function renderNode(
  node: JsonNode,
  label: { key: string; bareKey: boolean } | number | null,
  path: string,
  depth: number,
  last: boolean,
  ctx: RenderCtx,
): HTMLElement {
  if (!isContainer(node)) {
    const row = el("div", "jt-leaf");
    const lab = labelFor(label);
    if (lab) {
      row.appendChild(lab);
      row.appendChild(el("span", "jt-colon", ":"));
    }
    row.appendChild(leafValue(node));
    if (!last) row.appendChild(el("span", "jt-comma", ","));
    return row;
  }

  // Pulled out as consts, not as a boolean flag: TypeScript keeps a const's
  // narrowing inside the `fill` closure below, but would re-widen `node` there.
  const entries = node.kind === "object" ? node.entries : null;
  const items = node.kind === "object" ? null : node.items;
  const open = entries ? "{" : "[";
  const close = entries ? "}" : "]";
  const count = entries?.length ?? items?.length ?? 0;

  const details = document.createElement("details");
  details.className = "jt-node";
  details.dataset.path = path;
  // Empty containers have nothing to reveal; rendering them as a plain row
  // avoids a disclosure triangle that opens onto nothing.
  if (count === 0) {
    const row = el("div", "jt-leaf");
    const lab = labelFor(label);
    if (lab) {
      row.appendChild(lab);
      row.appendChild(el("span", "jt-colon", ":"));
    }
    row.appendChild(el("span", "jt-brace", open + close));
    if (!last) row.appendChild(el("span", "jt-comma", ","));
    return row;
  }

  const wantOpen = ctx.fullExpand || depth < AUTO_OPEN_DEPTH;
  details.open = ctx.openState.get(path) ?? wantOpen;
  // Setting `.open` queues a `toggle` event of its own. Recording the state we
  // rendered lets the listener below tell that echo apart from a real click.
  details.dataset.rendered = details.open ? "1" : "0";

  const summary = document.createElement("summary");
  summary.className = "jt-summary";
  const lab = labelFor(label);
  if (lab) {
    summary.appendChild(lab);
    summary.appendChild(el("span", "jt-colon", ":"));
  }
  summary.appendChild(el("span", "jt-brace", open));
  // Shown only while collapsed (CSS hides it when open): `{…} 3 items`.
  const hint = el("span", "jt-hint");
  hint.appendChild(el("span", "jt-ellipsis", "…"));
  hint.appendChild(el("span", "jt-brace", close));
  hint.appendChild(el("span", "jt-count", countLabel(count)));
  if (!last) hint.appendChild(el("span", "jt-comma", ","));
  summary.appendChild(hint);
  details.appendChild(summary);

  const children = el("div", "jt-children");
  details.appendChild(children);

  const tail = el("div", "jt-tail");
  tail.appendChild(el("span", "jt-brace", close));
  if (!last) tail.appendChild(el("span", "jt-comma", ","));
  details.appendChild(tail);

  const fill = (): void => {
    if (entries) {
      entries.forEach((entry, i) => {
        children.appendChild(
          renderNode(entry.value, entry, childPath(path, entry.key), depth + 1, i === entries.length - 1, ctx),
        );
      });
    } else if (items) {
      items.forEach((item, i) => {
        children.appendChild(renderNode(item, i, childPath(path, i), depth + 1, i === items.length - 1, ctx));
      });
    }
  };

  if (details.open) {
    fill();
  } else {
    // Deferred: a closed branch in a big document costs nothing until opened.
    children.dataset.pending = "1";
    const onToggle = (): void => {
      if (!details.open || children.dataset.pending !== "1") return;
      delete children.dataset.pending;
      fill();
    };
    details.addEventListener("toggle", onToggle);
  }
  return details;
}

/** The parse-error panel, with a click-through to the offending position. */
function renderError(error: JsonParseError, onJump: JsonTreeOptions["onJump"]): HTMLElement {
  const box = el("div", "jt-error");
  box.appendChild(el("div", "jt-error-title", "Invalid JSON"));
  box.appendChild(el("div", "jt-error-msg", error.message));
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "jt-error-jump";
  jump.textContent = `Line ${error.line}, column ${error.column}`;
  jump.addEventListener("click", () => onJump(error.line, error.column));
  box.appendChild(jump);
  return box;
}

/**
 * Render a parsed document into a detached element for the preview pane.
 * Registers one delegated `toggle` listener that records what the user closed,
 * so the next re-render (every keystroke, debounced) comes back the same shape.
 */
export function renderJsonTree(result: JsonParseResult, opts: JsonTreeOptions): HTMLElement {
  const root = el("div", "json-view");

  if (!result.node) {
    if (result.error) root.appendChild(renderError(result.error, opts.onJump));
    return root;
  }

  if (result.lenient) {
    // Worth saying out loud: the file parsed, but a strict JSON consumer would
    // reject it, and that is usually news to whoever is looking at it.
    root.appendChild(
      el("div", "jt-notice", "Lenient parse — this document uses syntax that strict JSON does not allow."),
    );
  }

  let openState = openStateByTab.get(opts.tabId);
  if (!openState) {
    openState = new Map<string, boolean>();
    openStateByTab.set(opts.tabId, openState);
  }
  const ctx: RenderCtx = { openState, fullExpand: result.nodeCount <= FULL_EXPAND_NODE_LIMIT };

  const tree = el("div", "jt-root");
  tree.appendChild(renderNode(result.node, null, "$", 0, true, ctx));
  // `toggle` doesn't bubble, so this listens in the capture phase; one listener
  // then covers the lazily added branches too.
  tree.addEventListener(
    "toggle",
    (e) => {
      const target = e.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      const path = target.dataset.path;
      if (!path) return;
      const now = target.open ? "1" : "0";
      // The echo of our own initial `.open` assignment — not a user choice.
      if (target.dataset.rendered === now) return;
      target.dataset.rendered = now;
      openState.set(path, target.open);
    },
    true,
  );
  root.appendChild(tree);
  return root;
}
