/**
 * Clipboard HTML → Markdown.
 *
 * The clipboard carries two flavors of the same copy: `text/plain`, which is the
 * rendered text with every heading, list marker and table gone, and `text/html`,
 * which still has the structure. Pasting the plain flavor into a Markdown tab
 * throws that structure away — this converts the HTML one back into Markdown
 * instead (the same trick Obsidian uses on paste).
 *
 * Turndown and DOMPurify load lazily on first use, so a session that never
 * pastes HTML pays nothing at start (same rule as the preview's marked/mermaid).
 * The HTML is sanitized before conversion: it comes from another application and
 * is parsed into a real DOM here, so scripts and event handlers must go first.
 */
import type TurndownService from "turndown";

/** turndown declares itself with `export =`, so the type is the class while the
 *  browser ES build actually exports it as `default`. The constructor type is
 *  spelled out here rather than read off the module. */
type Turndown = new (options?: ConstructorParameters<typeof TurndownService>[0]) => TurndownService;
type Purify = typeof import("dompurify")["default"];

let service: TurndownService | null = null;
let purify: Purify | null = null;
let loading: Promise<TurndownService> | null = null;

/** Elements that carry no document content — page furniture that would otherwise
 *  land in the text as stray words ("Copy", "Edit") when copying from a web app. */
const DROPPED = ["script", "style", "noscript", "button", "svg", "form", "select"];

function build(Turndown: Turndown): TurndownService {
  const td = new Turndown({
    headingStyle: "atx", // "## Heading", not the underlined form
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.remove(DROPPED as Parameters<TurndownService["remove"]>[0]);

  // Inline images arrive as multi-hundred-KB data: URLs. Keeping them would bury
  // the pasted text in base64, and a plain-text editor has nowhere to put the
  // binary, so only the alt text survives.
  td.addRule("dataImage", {
    filter: (node: HTMLElement) =>
      node.nodeName === "IMG" && (node.getAttribute("src") ?? "").startsWith("data:"),
    replacement: (_content: string, node: Node) => {
      const alt = (node as HTMLElement).getAttribute("alt")?.trim();
      return alt ? `![${alt}]()` : "";
    },
  });

  return td;
}

/**
 * List items with a single space after the marker (`- item`, `1. item`) and a
 * two-space continuation indent, instead of Turndown's four-column padding
 * (`-   item`). Both are valid Markdown; this is the form the editor's own
 * grammar, the preview and every hand-written list in this project use, so a
 * pasted list stops looking foreign next to the lines around it.
 */
function listItemRule(td: TurndownService): Parameters<TurndownService["addRule"]>[1] {
  return {
    filter: "li",
    replacement: (content: string, node: Node) => {
      const el = node as HTMLElement;
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/gm, "\n  "); // continuation lines line up under the text
      const parent = el.parentNode as HTMLElement | null;
      let prefix = `${td.options.bulletListMarker} `;
      if (parent && parent.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? 1);
        const index = Array.prototype.indexOf.call(parent.children, el);
        prefix = `${(Number.isFinite(start) ? start : 1) + index}. `;
      }
      return prefix + body + (el.nextSibling && !/\n$/.test(body) ? "\n" : "");
    },
  };
}

/** Load the converter once; subsequent pastes reuse it. */
function ensureService(): Promise<TurndownService> {
  if (service) return Promise.resolve(service);
  if (!loading) {
    loading = Promise.all([
      import("turndown"),
      import("turndown-plugin-gfm"),
      import("dompurify"),
    ]).then(([turndownMod, gfm, { default: DOMPurify }]) => {
      const Turndown = (turndownMod as unknown as { default: Turndown }).default;
      const td = build(Turndown);
      // Tables, strikethrough and task lists are GFM, not CommonMark: without
      // this plugin a pasted table is silently flattened into a run of text.
      td.use(gfm.gfm);
      // The plugin emits a single tilde (`~gone~`). The editor's own Markdown
      // grammar and every renderer this app talks to want the doubled form, so
      // override it — rules added later win (turndown unshifts them).
      td.addRule("strikethrough", {
        filter: ["del", "s"],
        replacement: (content: string) => `~~${content}~~`,
      });
      td.addRule("listItem", listItemRule(td));
      service = td;
      purify = DOMPurify;
      return td;
    });
  }
  return loading;
}

/**
 * Convert a clipboard HTML fragment to Markdown. Returns "" when the fragment
 * has no textual content (an image-only or empty copy); callers treat that as
 * "nothing converted" and fall back to the plain-text flavor.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const td = await ensureService();
  const clean = purify ? purify.sanitize(html, { USE_PROFILES: { html: true } }) : html;
  // Turndown reproduces the blank lines around the source structure; a paste
  // should start and end exactly where the caret is.
  return td.turndown(clean).replace(/^\s+|\s+$/g, "");
}
