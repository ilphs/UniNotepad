/**
 * Drives dist/extension.js against a stub `vscode` module: activate it, open a
 * preview, complete the ready handshake, then exercise zoom and export.
 *
 * This is the only way to run the extension-host half without launching VS Code,
 * and it covers the parts most likely to be wrong on a first port: registration
 * counts, the HTML shell's CSP/nonce/URI wiring, and the message round-trips.
 */
"use strict";
const Module = require("module");
const assert = require("assert");

// ---- Stub vscode -----------------------------------------------------------

const posted = [];
let messageHandler = null;
let disposeHandler = null;
let capturedHtml = "";
let createdPanels = 0;
let savedBytes = null;
const registered = new Map();
const openedUris = [];
let serializerViewType = null;
const themeListeners = [];
const docChangeListeners = [];
const visibleRangeListeners = [];
const activeEditorListeners = [];
const closeDocListeners = [];

function mkUri(str) {
  const u = {
    scheme: str.split(":")[0],
    path: str.replace(/^[a-z]+:\/\//, "/").replace(/^\/+/, "/"),
    fsPath: str.replace(/^file:\/\//, ""),
    toString: () => str,
  };
  return u;
}

/**
 * The returned disposable must actually unhook the listener. A no-op dispose()
 * leaves every listener live forever, which makes a correct teardown look broken
 * (and would hide a real leak just as easily).
 */
function event(sink) {
  return function (listener, thisArgs, disposables) {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    sink.push(bound);
    const d = {
      dispose() {
        const i = sink.indexOf(bound);
        if (i >= 0) sink.splice(i, 1);
      },
    };
    if (disposables) disposables.push(d);
    return d;
  };
}

const doc = {
  uri: mkUri("file:///tmp/sample.md"),
  languageId: "markdown",
  lineCount: 40,
  getText: () => "# Title\n\nbody text\n",
};

const config = {
  mermaidBackground: "255,255,255,1",
  mermaidBackgroundEnabled: false,
  scrollEditorWithPreview: true,
};

/**
 * A fresh panel per createWebviewPanel call, each with its own message channel —
 * sharing one stub across panels crosses the `requestHtml` replies and the failure
 * looks like a product bug. Only the newest panel is left `active`, which is also
 * how VS Code behaves and is what makes `PreviewPanel.active()` deterministic here.
 */
const panels = [];
let panelStub = null;

function makePanel() {
  for (const p of panels) p.active = false;
  const self = {
    active: true,
    viewColumn: 2,
    webview: {
      html: "",
      options: {},
      cspSource: "vscode-webview://stub",
      asWebviewUri: (u) => mkUri("https://stub.vscode-cdn.net" + u.path),
      onDidReceiveMessage: (h, thisArgs, disposables) => {
        self.handler = thisArgs ? h.bind(thisArgs) : h;
        messageHandler = self.handler;
        const d = { dispose() {} };
        if (disposables) disposables.push(d);
        return d;
      },
      postMessage: (m) => {
        posted.push(m);
        return Promise.resolve(true);
      },
    },
    onDidDispose: (h, thisArgs, disposables) => {
      self.disposeHandler = thisArgs ? h.bind(thisArgs) : h;
      disposeHandler = self.disposeHandler;
      const d = { dispose() {} };
      if (disposables) disposables.push(d);
      return d;
    },
    reveal() {
      self.reveals++;
    },
    reveals: 0,
    dispose() {
      if (self.disposeHandler) self.disposeHandler();
    },
  };
  panels.push(self);
  panelStub = self;
  return self;
}

const vscode = {
  Uri: {
    parse: mkUri,
    file: (p) => mkUri("file://" + p),
    joinPath: (base, ...parts) => {
      let path = base.toString().replace(/\/+$/, "");
      for (const p of parts) {
        if (p === "..") path = path.replace(/\/[^/]*$/, "");
        else path += "/" + String(p).replace(/^\/+/, "");
      }
      return mkUri(path);
    },
  },
  ViewColumn: { One: 1, Two: 2, Three: 3, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Disposable: class {
    constructor(fn) {
      this.dispose = fn || (() => {});
    }
  },
  commands: {
    registerCommand(id, fn) {
      registered.set(id, fn);
      return { dispose() {} };
    },
    executeCommand(id, ...a) {
      return registered.get(id)(...a);
    },
  },
  window: {
    activeTextEditor: { document: doc },
    createWebviewPanel(_viewType, title) {
      createdPanels++;
      const p = makePanel();
      p.title = title;
      return p;
    },
    registerWebviewPanelSerializer(viewType) {
      serializerViewType = viewType;
      return { dispose() {} };
    },
    onDidChangeActiveColorTheme: event(themeListeners),
    onDidChangeActiveTextEditor: event(activeEditorListeners),
    onDidChangeTextEditorVisibleRanges: event(visibleRangeListeners),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: (m) => {
      console.error("  [showErrorMessage]", m);
      return Promise.resolve(undefined);
    },
    showSaveDialog: () => Promise.resolve(mkUri("file:///tmp/out.html")),
    showTextDocument: () => Promise.resolve({}),
  },
  workspace: {
    onDidChangeTextDocument: event(docChangeListeners),
    onDidChangeConfiguration: event([]),
    onDidCloseTextDocument: event(closeDocListeners),
    openTextDocument: (u) => {
      openedUris.push(u);
      return Promise.resolve(doc);
    },
    getConfiguration: () => ({
      get: (k, d) => (k in config ? config[k] : d),
      update: (k, v) => {
        config[k] = v;
        return Promise.resolve();
      },
    }),
    fs: {
      writeFile: (_uri, bytes) => {
        savedBytes = bytes;
        return Promise.resolve();
      },
    },
  },
  env: { openExternal: () => Promise.resolve(true) },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  return origLoad(request, parent, isMain);
};

// ---- Drive -----------------------------------------------------------------

const ext = require(require("node:path").join(__dirname, "..", "dist", "extension.js"));
const subs = [];
ext.activate({ extensionUri: mkUri("file:///ext"), subscriptions: subs });

const pass = [];
function ok(name) {
  pass.push(name);
  console.log("  ok  " + name);
}

assert.strictEqual(typeof ext.activate, "function");
assert.strictEqual(typeof ext.deactivate, "function");
ok("activate/deactivate exported");

for (const id of [
  "uninotepadPreview.open",
  "uninotepadPreview.openFromExplorer",
  "uninotepadPreview.zoomIn",
  "uninotepadPreview.zoomOut",
  "uninotepadPreview.zoomReset",
  "uninotepadPreview.exportHtml",
]) {
  assert.ok(registered.has(id), "command not registered: " + id);
}
ok("all 6 commands registered");

assert.strictEqual(serializerViewType, "uninotepad.markdownPreview");
ok("serializer registered for the panel view type");

// --- open the preview
vscode.commands.executeCommand("uninotepadPreview.open");
assert.strictEqual(createdPanels, 1);
capturedHtml = panelStub.webview.html;
ok("preview panel created");

assert.ok(/Content-Security-Policy/.test(capturedHtml), "no CSP meta");
assert.ok(/script-src 'nonce-[A-Za-z0-9]{32}'/.test(capturedHtml), "script-src nonce missing/short");
const nonceInTag = /<script nonce="([A-Za-z0-9]{32})"/.exec(capturedHtml);
const nonceInCsp = /script-src 'nonce-([A-Za-z0-9]{32})'/.exec(capturedHtml);
assert.ok(nonceInTag && nonceInCsp && nonceInTag[1] === nonceInCsp[1], "nonce mismatch CSP vs tag");
ok("CSP nonce matches the script tag");

assert.ok(/style-src [^;]*'unsafe-inline'/.test(capturedHtml), "mermaid needs style-src unsafe-inline");
ok("style-src allows mermaid's injected styles");
assert.ok(/default-src 'none'/.test(capturedHtml), "default-src not locked down");
ok("default-src 'none'");

assert.ok(capturedHtml.includes("stub.vscode-cdn.net/ext/dist/webview.js"), "script src not a webview URI");
assert.ok(capturedHtml.includes("stub.vscode-cdn.net/ext/media/preview.css"), "css href not a webview URI");
ok("script/style go through asWebviewUri");

assert.ok(capturedHtml.includes('data-source-uri="file:///tmp/sample.md"'), "source uri attribute missing");
ok("source URI embedded for the serializer");

// re-running the command must reveal, not stack a second panel
vscode.commands.executeCommand("uninotepadPreview.open");
assert.strictEqual(createdPanels, 1);
ok("second open reveals instead of duplicating");

// --- nothing may be posted before ready
assert.strictEqual(posted.length, 0, "posted before ready: " + JSON.stringify(posted));
ok("no messages posted before the ready handshake");

// --- ready handshake
assert.ok(messageHandler, "onDidReceiveMessage never registered");
messageHandler({ type: "ready" });
const types = posted.map((m) => m.type);
assert.ok(types.includes("settings"), "settings not pushed on ready: " + types);
const content = posted.find((m) => m.type === "content");
assert.ok(content, "content not pushed on ready: " + types);
assert.strictEqual(content.text, "# Title\n\nbody text\n");
assert.strictEqual(content.fileType, "markdown");
ok("ready → settings + content pushed with the document text");

assert.strictEqual(panelStub.title, "Preview sample.md");
ok("panel titled after its source document");

// --- .mmd detection, and: running open from a second document retargets the one
//     panel instead of stacking another
const mmdDoc = Object.assign({}, doc, { uri: mkUri("file:///tmp/chart.mmd"), languageId: "plaintext" });
vscode.window.activeTextEditor = { document: mmdDoc };
posted.length = 0;
createdPanels = 0;
vscode.commands.executeCommand("uninotepadPreview.open");
assert.strictEqual(createdPanels, 0, "open on a second document must reuse the panel");
const mmdContent = posted.find((m) => m.type === "content");
assert.ok(mmdContent, "retargeting did not push the new document");
assert.strictEqual(mmdContent.fileType, "mermaid", "a .mmd document must render as one diagram");
assert.strictEqual(mmdContent.uri, "file:///tmp/chart.mmd", "content must carry the new source URI");
assert.strictEqual(panelStub.title, "Preview chart.mmd", "the panel title must follow the target");
ok(".mmd typed as mermaid; open retargets the single panel and retitles it");

// --- following the active editor
assert.ok(activeEditorListeners.length > 0, "no active-editor listener registered");

// Focusing the webview clears activeTextEditor and fires this event. Following it
// would blank the preview the instant the user clicks in to pan a diagram.
posted.length = 0;
activeEditorListeners.forEach((f) => f(undefined));
assert.strictEqual(posted.length, 0, "an undefined active editor must not retarget");
ok("focusing the webview (undefined editor) does not retarget");

// A file this preview cannot render must not hijack the panel.
posted.length = 0;
const tsDoc = Object.assign({}, doc, { uri: mkUri("file:///tmp/main.ts"), languageId: "typescript" });
activeEditorListeners.forEach((f) => f({ document: tsDoc }));
assert.strictEqual(posted.length, 0, "a non-previewable editor must not retarget");
ok("switching to a non-Markdown editor keeps the last render");

// Clicking the source editor back into focus fires this too; re-rendering the
// document already shown would discard the reader's scroll position for nothing.
posted.length = 0;
activeEditorListeners.forEach((f) => f({ document: mmdDoc }));
assert.strictEqual(posted.length, 0, "re-focusing the current document must not re-render");
ok("re-focusing the current document does not re-render");

// The feature itself.
posted.length = 0;
const otherDoc = Object.assign({}, doc, { uri: mkUri("file:///tmp/notes.md"), languageId: "markdown" });
activeEditorListeners.forEach((f) => f({ document: otherDoc }));
const followed = posted.find((m) => m.type === "content");
assert.ok(followed, "switching editors did not push the new document");
assert.strictEqual(followed.uri, "file:///tmp/notes.md");
assert.strictEqual(followed.fileType, "markdown");
assert.strictEqual(panelStub.title, "Preview notes.md");
ok("switching to another Markdown editor retargets the preview");

// Closing the previewed document used to dispose the panel. With one panel
// following the editor that is wrong: the next Markdown file would have used it.
posted.length = 0;
createdPanels = 0;
vscode.window.activeTextEditor = { document: mmdDoc };
closeDocListeners.forEach((f) => f(otherDoc));
assert.strictEqual(createdPanels, 0, "closing a document must not reopen a panel");
const afterClose = posted.find((m) => m.type === "content");
assert.ok(afterClose, "closing the target did not retarget to the active editor");
assert.strictEqual(afterClose.uri, "file:///tmp/chart.mmd");
ok("closing the previewed document retargets instead of disposing");

// --- theme change re-pushes content (mermaid bakes colors into the SVG)
posted.length = 0;
assert.ok(themeListeners.length > 0, "no theme listener registered");
themeListeners.forEach((f) => f());
assert.ok(
  posted.some((m) => m.type === "content"),
  "theme change did not re-push content",
);
ok("theme change re-pushes content");

// --- zoom routing
panelStub.active = true;
posted.length = 0;
vscode.commands.executeCommand("uninotepadPreview.zoomIn");
vscode.commands.executeCommand("uninotepadPreview.zoomOut");
vscode.commands.executeCommand("uninotepadPreview.zoomReset");
assert.deepStrictEqual(
  posted.filter((m) => m.type === "zoom").map((m) => m.dir),
  [1, -1, 0],
);
ok("zoom in/out/reset forwarded with the right direction");

// --- scroll fraction
posted.length = 0;
visibleRangeListeners.forEach((f) =>
  f({
    textEditor: { document: mmdDoc },
    visibleRanges: [{ start: { line: 0 }, end: { line: 9 } }],
  }),
);
let scroll = posted.find((m) => m.type === "scroll");
assert.ok(scroll, "no scroll message at the top");
assert.strictEqual(scroll.fraction, 0);
posted.length = 0;
visibleRangeListeners.forEach((f) =>
  f({
    textEditor: { document: mmdDoc },
    visibleRanges: [{ start: { line: 30 }, end: { line: 39 } }],
  }),
);
scroll = posted.find((m) => m.type === "scroll");
assert.strictEqual(scroll.fraction, 1, "the last screenful must reach 1.0, got " + scroll.fraction);
ok("scroll fraction spans 0→1 across the document");

// --- setSetting is written to global configuration
messageHandler({ type: "setSetting", key: "mermaidBackgroundEnabled", value: true });
assert.strictEqual(config.mermaidBackgroundEnabled, true);
ok("setSetting reaches configuration");

(async () => {
  // --- context-menu path: the clicked URI is what gets previewed, with no
  // active editor involved (in the explorer the file need not even be open)
  const savedEditor = vscode.window.activeTextEditor;
  vscode.window.activeTextEditor = undefined;
  const revealsBefore = panelStub.reveals;
  const createdBefore = createdPanels;
  await vscode.commands.executeCommand(
    "uninotepadPreview.openFromExplorer",
    mkUri("file:///tmp/sample.md"),
  );
  vscode.window.activeTextEditor = savedEditor;
  assert.strictEqual(openedUris.length, 1, "the clicked URI was never opened");
  assert.strictEqual(openedUris[0].toString(), "file:///tmp/sample.md");
  assert.strictEqual(createdPanels, createdBefore, "context menu stacked a second panel");
  assert.ok(panelStub.reveals > revealsBefore, "existing panel not revealed");
  ok("explorer/tab context menu previews the clicked URI without an active editor");

  // --- export round-trip
  posted.length = 0;
  const exporting = vscode.commands.executeCommand("uninotepadPreview.exportHtml");
  await new Promise((r) => setImmediate(r));
  const req = posted.find((m) => m.type === "requestHtml");
  assert.ok(req, "export did not request the rendered HTML");
  messageHandler({ type: "html", token: req.token, html: "<h1>Title</h1>" });
  await exporting;
  assert.ok(savedBytes, "nothing written");
  const written = Buffer.from(savedBytes).toString("utf8");
  assert.ok(written.startsWith("<!doctype html>"), "not a standalone document");
  assert.ok(written.includes("<h1>Title</h1>"), "body not embedded");
  assert.ok(written.includes(".mmd-toolbar { display: none; }"), "toolbar not hidden in the export");
  ok("export round-trip writes a standalone HTML document");

  // --- a stale export token must not resolve a newer request
  posted.length = 0;
  savedBytes = null;
  const second = vscode.commands.executeCommand("uninotepadPreview.exportHtml");
  await new Promise((r) => setImmediate(r));
  const req2 = posted.find((m) => m.type === "requestHtml");
  assert.notStrictEqual(req2.token, req.token, "tokens must not repeat");
  messageHandler({ type: "html", token: req.token, html: "STALE" });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(savedBytes, null, "a stale token resolved the new request");
  messageHandler({ type: "html", token: req2.token, html: "<p>fresh</p>" });
  await second;
  assert.ok(Buffer.from(savedBytes).toString("utf8").includes("<p>fresh</p>"));
  ok("stale export token is ignored");

  // --- dispose cleanup
  panelStub.dispose();
  posted.length = 0;
  docChangeListeners.forEach((f) => f({ document: mmdDoc }));
  await new Promise((r) => setTimeout(r, 260));
  assert.strictEqual(posted.length, 0, "a disposed panel still receives pushes");
  ok("dispose unhooks the document listeners");

  console.log("\n" + pass.length + " checks passed");
})().catch((e) => {
  console.error("\nFAILED: " + e.message);
  process.exit(1);
});
