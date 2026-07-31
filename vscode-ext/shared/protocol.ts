/**
 * The extension-host ↔ webview message contract.
 *
 * Imported by both bundles, which is the whole point: the host cannot reach into
 * the webview's DOM and the webview cannot call the VS Code API, so every
 * interaction between them is one of the shapes below. Keeping them in one file
 * means a rename breaks the typecheck on both sides at once instead of silently
 * dropping messages at runtime.
 */

/** Which renderer the document gets. Mirrors UniNotepad's `effectiveFileType`
 *  narrowed to the two types that can preview at all. */
export type PreviewFileType = "markdown" | "mermaid";

/** The subset of settings the webview needs. Sent whole on every change rather
 *  than diffed — it is four scalars, and a diff would need its own protocol. */
export interface PreviewSettings {
  /** Backdrop as "r,g,b,a" (0-255 channels, 0-1 alpha). Parsed in the webview so
   *  a malformed user setting falls back there, next to the code that paints it. */
  mermaidBackground: string;
  mermaidBackgroundEnabled: boolean;
}

export type HostToWebview =
  /** Full document text. Sent on open, on every edit (debounced host-side), on
   *  theme change, and whenever the panel retargets to a different document.
   *  `fileType` can change without the text changing — Save As to a different
   *  extension — so it rides along on every message. `uri` is what tells the
   *  webview a *different* document arrived rather than a new revision of the
   *  same one: it re-stamps the persisted view state (which the serializer needs
   *  after a window reload) and resets the scroll, which an edit must not do. */
  | { type: "content"; text: string; fileType: PreviewFileType; uri: string }
  /** Editor scroll position as a 0-1 fraction of its scrollable range. */
  | { type: "scroll"; fraction: number }
  /** 1 = in, -1 = out, 0 = reset to 100%. */
  | { type: "zoom"; dir: 1 | -1 | 0 }
  | { type: "settings"; settings: PreviewSettings }
  /** Ask for the rendered `.md-body` innerHTML. `token` comes back on the reply
   *  so a second export started before the first answered can't be crossed. */
  | { type: "requestHtml"; token: number };

export type WebviewToHost =
  /** The webview finished mounting and can accept content. The host holds the
   *  first `content` message until this arrives — `webview.html = ...` resets all
   *  script state, so a postMessage sent before the listener exists is lost. */
  | { type: "ready" }
  /** Persist a setting. The webview has no API access, so every write to
   *  configuration is routed through the host. */
  | {
      type: "setSetting";
      key: "mermaidBackground" | "mermaidBackgroundEnabled";
      value: string | boolean;
    }
  | { type: "html"; token: number; html: string }
  /** A link click inside the rendered Markdown. Handled host-side so `http(s)`
   *  goes to the browser and a relative path opens as a workspace document. */
  | { type: "openLink"; href: string };
