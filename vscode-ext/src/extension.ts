/**
 * Activation, commands, and webview restore.
 *
 * Everything document- and sync-related lives in panel.ts; this file only wires
 * VS Code's entry points to it.
 */
import * as vscode from "vscode";
import { PreviewPanel, VIEW_TYPE } from "./panel";

export function activate(context: vscode.ExtensionContext): void {
  const { extensionUri } = context;

  context.subscriptions.push(
    vscode.commands.registerCommand("uninotepadPreview.open", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Open a Markdown or Mermaid document first.");
        return;
      }
      PreviewPanel.show(editor.document, extensionUri);
    }),

    // The explorer and editor-tab context menus hand us the clicked resource,
    // which is not necessarily the active editor — and in the explorer it may
    // not be open at all, so the document has to be loaded before showing it.
    vscode.commands.registerCommand("uninotepadPreview.openFromExplorer", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showInformationMessage("Open a Markdown or Mermaid document first.");
        return;
      }
      try {
        PreviewPanel.show(await vscode.workspace.openTextDocument(target), extensionUri);
      } catch (e) {
        void vscode.window.showErrorMessage(`Failed to open the preview: ${(e as Error).message}`);
      }
    }),

    // Zoom is routed through the host even though the state lives in the webview:
    // a webview cannot register a VS Code keybinding, and the app's own zoom
    // shortcuts are what users will reach for. The `when` clauses in package.json
    // (activeWebviewPanelId) keep these from shadowing the editor-font zoom
    // everywhere else.
    vscode.commands.registerCommand("uninotepadPreview.zoomIn", () => PreviewPanel.active()?.zoom(1)),
    vscode.commands.registerCommand("uninotepadPreview.zoomOut", () => PreviewPanel.active()?.zoom(-1)),
    vscode.commands.registerCommand("uninotepadPreview.zoomReset", () => PreviewPanel.active()?.zoom(0)),

    vscode.commands.registerCommand("uninotepadPreview.exportHtml", () => exportHtml()),

    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
        const uri = (state as { uri?: unknown } | null)?.uri;
        if (typeof uri !== "string") {
          // Nothing to re-attach to. Leaving the panel up would show an empty
          // shell that never renders, so close it.
          panel.dispose();
          return;
        }
        await PreviewPanel.restore(panel, vscode.Uri.parse(uri), extensionUri);
      },
    }),
  );
}

export function deactivate(): void {
  /* Panels dispose themselves through context.subscriptions and onDidDispose. */
}

// ---- Export ----------------------------------------------------------------

async function exportHtml(): Promise<void> {
  const panel = PreviewPanel.active();
  if (!panel) {
    void vscode.window.showInformationMessage("Focus a UniNotepad preview before exporting.");
    return;
  }

  let body: string;
  try {
    body = await panel.renderedHtml();
  } catch (e) {
    void vscode.window.showErrorMessage(`Failed to read the preview: ${(e as Error).message}`);
    return;
  }

  const target = await vscode.window.showSaveDialog({
    filters: { HTML: ["html"] },
    saveLabel: "Export",
    defaultUri: vscode.Uri.file(panel.title.replace(/\.[^.]+$/, "") + ".html"),
  });
  if (!target) return;

  try {
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(htmlDocument(panel.title, body)),
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`Failed to export: ${(e as Error).message}`);
    return;
  }

  // VS Code webviews cannot call window.print() — the sandbox has no
  // allow-modals — so exporting and opening in a browser is the printing path.
  const open = await vscode.window.showInformationMessage(
    `Exported ${target.path.split("/").pop()}`,
    "Open in Browser",
  );
  if (open) await vscode.env.openExternal(target);
}

/** Wrap rendered body HTML in a minimal, self-contained HTML5 document. Ported
 *  from the app's `htmlDocument`, with the light-theme colors kept literal: the
 *  file leaves VS Code, so `--vscode-*` variables would resolve to nothing. */
function htmlDocument(title: string, body: string): string {
  const esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc}</title>
<style>
  /* Same split as the preview panel: the text keeps a readable column, a Mermaid
     diagram gets the whole page. */
  body { margin: 2rem auto; padding: 0 1rem; max-width: 1600px;
    font: 16px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; }
  body > *:not(.mermaid-frame) { max-width: 44rem; margin-inline: auto; }
  pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 6px; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  blockquote { border-left: 4px solid #ddd; margin: 0; padding-left: 1rem; color: #555; }
  /* Tables arrive wrapped in the scroll container the preview gives them, so the
     rules here mirror preview.css: the wrapper owns the flow margin and the
     overflow, and the table fills it unless its cells refuse to wrap. */
  .md-table-wrap { overflow-x: auto; margin: 0.8em 0; }
  table { border-collapse: collapse; width: auto; min-width: 100%; margin: 0; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; }
  img, svg { max-width: 100%; }
  .mmd-toolbar { display: none; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
