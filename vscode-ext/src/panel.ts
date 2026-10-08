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
 * At most one panel follows the active editor, the way VS Code's built-in preview
 * does; any number of others can be *locked* to one document each. Pinning every
 * panel per-document was the first shape here, and it was wrong twice over:
 * switching editors left the preview showing the file you had stopped looking at,
 * and the only way to see the new one was to open a second panel — so N Markdown
 * files meant N preview tabs, each holding a retained webview. Following the
 * editor collapses that to one panel whose target moves.
 *
 * Locking (the built-in preview's "Toggle Preview Locking") brings back several
 * previews side by side without reintroducing either problem: the following panel
 * still follows, and a locked panel — the one kind that costs a retained webview
 * per document — exists only because the user asked for it. Locking the
 * following panel pins it where it is; the next "open" then creates a new
 * following panel, which is how N previews come about.
 */
import * as vscode from "vscode";
import type { HostToWebview, PreviewFileType, PreviewSettings, WebviewToHost } from "../shared/protocol";
import { readPreviewImage } from "./images";

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

/** Every preview tab is named exactly like its source file: the `<>` tab icon
 *  already says "preview", and a prefix only pushes the file name out of a
 *  narrow tab. Follows the target on retarget, so it stays accurate. */
function titleFor(doc: vscode.TextDocument): string {
  return doc.uri.path.split("/").pop() ?? "";
}

/** Context key read by the lock/unlock `when` clauses in package.json: whether
 *  the *focused* preview is locked, so its title bar shows the right button. */
const LOCKED_CONTEXT = "uninotepadPreview.activeLocked";

function setLockedContext(locked: boolean): void {
  void vscode.commands.executeCommand("setContext", LOCKED_CONTEXT, locked);
}

function readSettings(): PreviewSettings {
  const cfg = vscode.workspace.getConfiguration("uninotepadPreview");
  return {
    mermaidBackground: cfg.get<string>("mermaidBackground", "255,255,255,1"),
    mermaidBackgroundEnabled: cfg.get<boolean>("mermaidBackgroundEnabled", false),
    // 0 = no cap (fill the panel). Keep in sync with the setting's declared
    // default in package.json — this fallback only fires if the contribution is
    // missing, but the two disagreeing would be a silent layout bug.
    contentWidth: cfg.get<number>("contentWidth", 0),
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
  /** The panel that follows the active editor, or nothing. Every "open" entry
   *  point retargets it when it exists, so a second following panel can never
   *  appear; locking it clears this slot (see `setLocked`). */
  private static following: PreviewPanel | undefined;
  /** Every live panel — the following one plus any locked ones. */
  private static readonly all = new Set<PreviewPanel>();

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

  /** The following preview: the editor-title button and the open keybinding.
   *
   *  `column` only matters when a panel is created — while a following panel
   *  exists, every later call retargets it in place and `reveal`s whatever column
   *  it is already in, so a second file previewed from a different origin cannot
   *  relocate it. Locked panels are never retargeted from here. Defaults to
   *  `Beside` because the button is explicitly labelled "to the Side". */
  static show(
    doc: vscode.TextDocument,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ): void {
    const existing = PreviewPanel.following;
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
      { viewColumn: column, preserveFocus: true },
      PreviewPanel.webviewOptions(extensionUri),
    );
    PreviewPanel.following = new PreviewPanel(panel, doc, extensionUri, false);
  }

  /** The Explorer / editor-tab context menu: a preview of *that* file in a tab
   *  of its own, locked to it — so right-clicking down a folder stacks one tab
   *  per file. A file that already has a locked tab gets that tab brought
   *  forward instead of a duplicate (a second copy would cost another retained
   *  webview and be indistinguishable from the first).
   *
   *  Locked rather than following because the menu names a file explicitly,
   *  which is what locking means, and because a second following panel would
   *  only mirror the first. The following panel is not touched.
   *
   *  `Active` (not `Beside`): the entry point is not labelled "to the Side", so
   *  the tab lands in the current column next to the source instead of
   *  splitting the window. */
  static openLocked(
    doc: vscode.TextDocument,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): void {
    const uri = doc.uri.toString();
    for (const p of PreviewPanel.all) {
      if (p.locked && p.doc.uri.toString() === uri) {
        p.panel.reveal(p.panel.viewColumn, /* preserveFocus */ true);
        return;
      }
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      titleFor(doc),
      { viewColumn: column, preserveFocus: true },
      PreviewPanel.webviewOptions(extensionUri),
    );
    // Registers itself in `all`; locked panels never take the following slot.
    new PreviewPanel(panel, doc, extensionUri, true);
  }

  /** Rebuild a panel VS Code restored after a window reload. The source document
   *  may be gone (file deleted, folder closed), in which case there is nothing to
   *  preview and the panel is disposed rather than left showing a stale render. */
  static async restore(
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    extensionUri: vscode.Uri,
    locked: boolean,
  ): Promise<void> {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      panel.dispose();
      return;
    }
    // Locked panels all come back. Of the following ones, VS Code can hand back
    // more than one (a window saved by a version where every panel was pinned, or
    // a split it restored): keep the first, drop the rest — two following panels
    // would show the same thing twice.
    if (!locked && PreviewPanel.following) {
      panel.dispose();
      return;
    }
    panel.webview.options = PreviewPanel.webviewOptions(extensionUri);
    const restored = new PreviewPanel(panel, doc, extensionUri, locked);
    if (!locked) PreviewPanel.following = restored;
  }

  /** The panel the zoom/export commands act on, and only while it holds focus.
   *  `reveal` does not steal focus (preserveFocus above), so this is undefined
   *  right after opening a preview — by design, since the keybindings that call it
   *  are gated on `activeWebviewPanelId` anyway. */
  static active(): PreviewPanel | undefined {
    for (const p of PreviewPanel.all) if (p.panel.active) return p;
    return undefined;
  }

  /** Lock or unlock the focused preview (the title-bar buttons). */
  static setActiveLocked(locked: boolean): void {
    PreviewPanel.active()?.setLocked(locked);
  }

  private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      // Zoom level, pan offset and scroll position are per-panel view state the
      // app kept per tab. Without this they reset every time the user switches
      // editor tabs, which reads as the preview losing its place. The documented
      // cost is memory for a hidden webview: a constant for the one following
      // panel, plus one per panel the user explicitly locked.
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, "dist"),
        vscode.Uri.joinPath(extensionUri, "media"),
      ],
    };
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    /** The document currently being previewed. Moves — see `retarget` — unless
     *  the panel is locked. */
    private doc: vscode.TextDocument,
    extensionUri: vscode.Uri,
    /** Pinned to `doc`: ignores editor switches. See `setLocked`. */
    private locked: boolean,
  ) {
    PreviewPanel.all.add(this);
    // Set here rather than trusted from creation/restore: a restored panel comes
    // back with whatever title it was serialized with.
    this.panel.title = titleFor(doc);
    // Tab icon. Not serialized across a window reload, so it is set here — the
    // constructor is the one path both `show` and `restore` go through.
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "toolbar-icon-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "media", "toolbar-icon-dark.svg"),
    };
    this.panel.webview.html = this.html(extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Keep the lock/unlock button in step with whichever preview has focus.
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active) setLockedContext(this.locked);
      },
      null,
      this.disposables,
    );
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
    // built-in preview does too. A locked panel always keeps its last render —
    // `follow` refuses to move it.
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

  /** Decide whether an editor switch should move the preview. A locked panel
   *  never moves. Otherwise three cases must NOT retarget, and each is a bug if
   *  it slips through:
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
    if (this.locked) return;
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

  /** Pin this panel to its document, or let it follow the editor again.
   *
   *  Locking gives up the following slot, so the next "open" creates a fresh
   *  following panel instead of retargeting this one. Unlocking takes the slot
   *  back, and there can only be one follower: the current one, if any, is
   *  closed. That loses nothing the user chose — it only ever showed whatever
   *  editor was focused, which this panel will now do instead. */
  private setLocked(locked: boolean): void {
    if (locked === this.locked) return;
    if (locked) {
      if (PreviewPanel.following === this) PreviewPanel.following = undefined;
    } else {
      const previous = PreviewPanel.following;
      if (previous && previous !== this) previous.panel.dispose();
      PreviewPanel.following = this;
    }
    this.locked = locked;
    this.pushLock();
    if (this.panel.active) setLockedContext(locked);
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

  /** Mirror the lock into the webview's persisted state — the serializer only
   *  gets that state back after a window reload, so it is where `locked` must
   *  live for a locked panel to come back locked. */
  private pushLock(): void {
    if (!this.ready) return;
    this.post({ type: "lock", locked: this.locked });
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
        this.pushLock();
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
      case "readImage":
        void this.readImage(msg.id, msg.src, msg.knownMtime);
        return;
    }
  }

  /** Answer a `readImage`. Always replies, error or not — the webview awaits
   *  every request it makes. Resolved against the document the panel shows now;
   *  a reply that lands after a retarget is dropped by the webview's render token. */
  private async readImage(id: number, src: string, knownMtime: number | null): Promise<void> {
    try {
      const r = await readPreviewImage(this.doc.uri, src, knownMtime);
      this.post({ type: "image", id, mtimeMs: r.mtimeMs, dataUri: r.dataUri });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.post({ type: "image", id, mtimeMs: null, dataUri: null, error });
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
    PreviewPanel.all.delete(this);
    if (PreviewPanel.following === this) PreviewPanel.following = undefined;
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer);
    // Anything still waiting on renderedHtml() would otherwise hang until its
    // own timeout; the waiters' reject path is the timer, so just drop them.
    this.htmlWaiters.clear();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
