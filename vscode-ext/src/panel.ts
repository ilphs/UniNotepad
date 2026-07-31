/**
 * One preview panel per source document, and everything that keeps it in sync.
 *
 * This is the half of `src/preview.ts` (UniNotepad) that VS Code takes over. The
 * app owned its own split: a draggable divider, per-tab pane visibility, a
 * flex-grow ratio, and a "which pane is selected" rule for routing zoom. None of
 * that survives the port — an editor group already does it, better — so what is
 * left here is the plumbing the app got for free by living in one window:
 * shipping the document text across the process boundary, and re-pushing it on
 * the three events that invalidate a render (edit, theme, file type).
 *
 * There is exactly one panel, and it follows the active editor the way VS Code's
 * built-in preview does. Pinning it per-document was the first shape here, and it
 * was wrong twice over: switching editors left the preview showing the file you
 * had stopped looking at, and the only way to see the new one was to open a second
 * panel — so N Markdown files meant N preview tabs, each holding a retained
 * webview. Following the editor collapses that to one panel whose target moves.
 */
import * as vscode from "vscode";
import type { HostToWebview, PreviewFileType, PreviewSettings, WebviewToHost } from "../shared/protocol";

export const VIEW_TYPE = "uninotepad.markdownPreview";

/** Matches the 200ms debounce in the app's `schedulePreviewRender`. Coalescing
 *  host-side rather than in the webview keeps whole documents off the message
 *  channel during a fast burst of keystrokes. */
const RENDER_DEBOUNCE_MS = 200;

/** Mermaid renders its own source: a `.mmd`/`.mermaid` document is one diagram,
 *  so it skips Markdown parsing entirely (see the webview's renderNow). */
function fileTypeOf(doc: vscode.TextDocument): PreviewFileType {
  if (doc.languageId === "mermaid") return "mermaid";
  return /\.(mmd|mermaid)$/i.test(doc.uri.path) ? "mermaid" : "markdown";
}

/** Whether a document is something this preview can render at all. Deliberately
 *  the same test as the `when` clause on the open keybinding in package.json: a
 *  file the button refuses to appear for must not be able to hijack the panel by
 *  merely being focused. */
function previewable(doc: vscode.TextDocument): boolean {
  return (
    doc.languageId === "markdown" ||
    doc.languageId === "mermaid" ||
    /\.(mmd|mermaid)$/i.test(doc.uri.path)
  );
}

function titleFor(doc: vscode.TextDocument): string {
  return `Preview ${doc.uri.path.split("/").pop() ?? ""}`;
}

function readSettings(): PreviewSettings {
  const cfg = vscode.workspace.getConfiguration("uninotepadPreview");
  return {
    mermaidBackground: cfg.get<string>("mermaidBackground", "255,255,255,1"),
    mermaidBackgroundEnabled: cfg.get<boolean>("mermaidBackgroundEnabled", false),
  };
}

/** Escape for an HTML double-quoted attribute value. A `file://` URI can carry
 *  `&` and quotes through a filename, and an unescaped one would break out of the
 *  attribute. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export class PreviewPanel {
  /** The one live preview, or nothing. Every entry point consults this before
   *  creating a panel, so a second one can never appear. */
  private static current: PreviewPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the webview reports `ready`. Until then every push is dropped:
   *  assigning `webview.html` resets all script state, so a message sent before
   *  the listener is installed is simply lost. Nothing needs to be queued — the
   *  `ready` handler pushes the current content and settings itself, and "current"
   *  is by definition everything a dropped push would have carried. */
  private ready = false;
  /** Resolvers for in-flight `requestHtml` round-trips, keyed by token. */
  private htmlWaiters = new Map<number, (html: string) => void>();
  private htmlToken = 0;

  static show(doc: vscode.TextDocument, extensionUri: vscode.Uri): void {
    const existing = PreviewPanel.current;
    if (existing) {
      // Running the command from a different file is the same intent as switching
      // to it, so retarget rather than stack a panel.
      existing.retarget(doc);
      existing.panel.reveal(existing.panel.viewColumn, /* preserveFocus */ true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      titleFor(doc),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      PreviewPanel.webviewOptions(extensionUri),
    );
    PreviewPanel.current = new PreviewPanel(panel, doc, extensionUri);
  }

  /** Rebuild a panel VS Code restored after a window reload. The source document
   *  may be gone (file deleted, folder closed), in which case there is nothing to
   *  preview and the panel is disposed rather than left showing a stale render. */
  static async restore(panel: vscode.WebviewPanel, uri: vscode.Uri, extensionUri: vscode.Uri): Promise<void> {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      panel.dispose();
      return;
    }
    // VS Code can hand back more than one serialized panel (a window saved before
    // this became single-panel, or a split it restored). Keep the first, drop the
    // rest — two panels would both follow the active editor and show the same
    // thing twice.
    if (PreviewPanel.current) {
      panel.dispose();
      return;
    }
    panel.webview.options = PreviewPanel.webviewOptions(extensionUri);
    PreviewPanel.current = new PreviewPanel(panel, doc, extensionUri);
  }

  /** The panel the zoom/export commands act on, and only while it holds focus.
   *  `reveal` does not steal focus (preserveFocus above), so this is undefined
   *  right after opening a preview — by design, since the keybindings that call it
   *  are gated on `activeWebviewPanelId` anyway. */
  static active(): PreviewPanel | undefined {
    const p = PreviewPanel.current;
    return p && p.panel.active ? p : undefined;
  }

  private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      // Zoom level, pan offset and scroll position are per-panel view state the
      // app kept per tab. Without this they reset every time the user switches
      // editor tabs, which reads as the preview losing its place. The documented
      // cost is memory for a hidden webview; there is only ever one panel, so
      // that cost is a constant.
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, "dist"),
        vscode.Uri.joinPath(extensionUri, "media"),
      ],
    };
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    /** The document currently being previewed. Moves — see `retarget`. */
    private doc: vscode.TextDocument,
    extensionUri: vscode.Uri,
  ) {
    this.panel.webview.html = this.html(extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: WebviewToHost) => this.onMessage(m),
      null,
      this.disposables,
    );

    // Live editing. Filtered to this panel's document so typing in an unrelated
    // file costs one string compare.
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() === this.doc.uri.toString()) this.scheduleContent();
      },
      null,
      this.disposables,
    );

    // Follow the active editor. Registered per panel so no listener exists while
    // no preview is open.
    vscode.window.onDidChangeActiveTextEditor(
      (editor) => this.follow(editor),
      null,
      this.disposables,
    );

    // Mermaid bakes theme colors into the SVG it produces, so a light/dark switch
    // needs a real re-render — a repaint would leave the old palette in place.
    vscode.window.onDidChangeActiveColorTheme(() => this.pushContent(), null, this.disposables);

    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("uninotepadPreview")) this.pushSettings();
      },
      null,
      this.disposables,
    );

    vscode.window.onDidChangeTextEditorVisibleRanges(
      (e) => {
        if (e.textEditor.document.uri.toString() === this.doc.uri.toString()) {
          this.pushScroll(e.textEditor, e.visibleRanges);
        }
      },
      null,
      this.disposables,
    );

    // The document went away underneath us. Disposing the panel here was the old
    // behaviour and it no longer fits: with one panel following the editor,
    // closing a file would take the preview down with it even though the next
    // Markdown file you open would have used it. Retarget if something previewable
    // is already focused; otherwise leave the last render up, which is what the
    // built-in preview does too.
    vscode.workspace.onDidCloseTextDocument(
      (closed) => {
        if (closed.uri.toString() === this.doc.uri.toString()) {
          this.follow(vscode.window.activeTextEditor);
        }
      },
      null,
      this.disposables,
    );
  }

  // ---- Retargeting ---------------------------------------------------------

  /** Decide whether an editor switch should move the preview. Three cases must
   *  NOT retarget, and each is a bug if it slips through:
   *
   *  - `undefined` — focusing the webview itself clears `activeTextEditor` and
   *    fires this event. Following it would blank the preview the instant the
   *    user clicks into it to pan a diagram.
   *  - a document this preview cannot render (a `.ts` file, an output channel) —
   *    keep the last Markdown up rather than clearing the pane, matching the
   *    built-in preview.
   *  - the document already shown — a re-render would discard scroll position
   *    for nothing. Note this also covers clicking the *source* editor back into
   *    focus, which fires the event with the same document.
   */
  private follow(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const doc = editor.document;
    if (!previewable(doc)) return;
    if (doc.uri.toString() === this.doc.uri.toString()) return;
    this.retarget(doc);
  }

  private retarget(doc: vscode.TextDocument): void {
    if (doc.uri.toString() === this.doc.uri.toString()) return;
    // A debounced render still queued for the old document would fire against the
    // new one and double up with the push below.
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.doc = doc;
    this.panel.title = titleFor(doc);
    this.pushContent();
  }

  // ---- Outbound ------------------------------------------------------------

  private post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private scheduleContent(): void {
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.pushContent();
    }, RENDER_DEBOUNCE_MS);
  }

  private pushContent(): void {
    if (!this.ready) return;
    this.post({
      type: "content",
      text: this.doc.getText(),
      fileType: fileTypeOf(this.doc),
      uri: this.doc.uri.toString(),
    });
  }

  private pushSettings(): void {
    if (!this.ready) return;
    this.post({ type: "settings", settings: readSettings() });
  }

  private pushScroll(editor: vscode.TextEditor, ranges: readonly vscode.Range[]): void {
    if (!this.ready) return;
    if (!vscode.workspace.getConfiguration("uninotepadPreview").get("scrollEditorWithPreview", true)) {
      return;
    }
    const first = ranges[0];
    if (!first) return;
    // Line-based stand-in for the app's scrollTop fraction: subtracting the
    // visible span is what lets the last screenful reach 1.0 — without it the
    // preview stops short of its own bottom no matter how far the editor scrolls.
    const visibleSpan = first.end.line - first.start.line;
    const denom = Math.max(1, editor.document.lineCount - 1 - visibleSpan);
    const fraction = Math.max(0, Math.min(1, first.start.line / denom));
    this.post({ type: "scroll", fraction });
  }

  zoom(dir: 1 | -1 | 0): void {
    this.post({ type: "zoom", dir });
  }

  /** Round-trip the rendered HTML out of the webview. Rejects rather than hanging
   *  if the webview never answers (disposed mid-flight, or a render that threw). */
  renderedHtml(timeoutMs = 3000): Promise<string> {
    const token = ++this.htmlToken;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.htmlWaiters.delete(token);
        reject(new Error("The preview did not respond."));
      }, timeoutMs);
      this.htmlWaiters.set(token, (html) => {
        clearTimeout(timer);
        resolve(html);
      });
      this.post({ type: "requestHtml", token });
    });
  }

  get title(): string {
    return this.doc.uri.path.split("/").pop() ?? "preview";
  }

  // ---- Inbound -------------------------------------------------------------

  private onMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.pushSettings();
        // `ready` is the first moment the webview can receive anything, so the
        // initial render is owed unconditionally.
        this.pushContent();
        return;
      case "setSetting":
        // Global, not workspace: the backdrop is a viewing preference, and
        // writing it per-folder would surprise a user who set it once.
        void vscode.workspace
          .getConfiguration("uninotepadPreview")
          .update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        return;
      case "html": {
        const waiter = this.htmlWaiters.get(msg.token);
        if (waiter) {
          this.htmlWaiters.delete(msg.token);
          waiter(msg.html);
        }
        return;
      }
      case "openLink":
        void this.openLink(msg.href);
        return;
    }
  }

  /** External schemes go to the browser; anything else is treated as a path
   *  relative to the source document and opened as an editor. Failures are
   *  reported rather than swallowed — a dead relative link in a document is
   *  worth knowing about. */
  private async openLink(href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const target = vscode.Uri.joinPath(this.doc.uri, "..", href);
    try {
      const linked = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(linked, { preview: false });
    } catch {
      void vscode.window.showWarningMessage(`Could not open: ${href}`);
    }
  }

  // ---- HTML shell ----------------------------------------------------------

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "preview.css"));
    const n = nonce();
    // `style-src 'unsafe-inline'` is load-bearing, not laziness: mermaid injects a
    // <style> element into every SVG it renders, so a nonce-only style policy
    // would strip the diagram's own colors. Scripts stay nonce-locked, which is
    // where the actual risk is — document text reaches the DOM only through
    // DOMPurify (Markdown) or mermaid's own strict sanitizer (diagrams).
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${n}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
    ].join("; ");
    // The source URI rides in a data attribute rather than an inline script: the
    // webview reads it and hands it to `setState`, which is what lets the
    // serializer re-attach the right document after a window reload. A data
    // attribute needs no CSP allowance at all, so the script policy stays
    // nonce-only.
    //
    // This is the URI at *mount* only. Retargeting deliberately does not rebuild
    // the shell — assigning `webview.html` would reset zoom, scroll and pan — so
    // the attribute goes stale as soon as the panel follows the editor elsewhere.
    // Keeping the persisted state honest is the job of the `uri` field on every
    // `content` message.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Preview</title>
</head>
<body>
<div id="preview-host" data-source-uri="${escapeAttr(this.doc.uri.toString())}"></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }

  // ---- Teardown ------------------------------------------------------------

  private dispose(): void {
    if (PreviewPanel.current === this) PreviewPanel.current = undefined;
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer);
    // Anything still waiting on renderedHtml() would otherwise hang until its
    // own timeout; the waiters' reject path is the timer, so just drop them.
    this.htmlWaiters.clear();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
