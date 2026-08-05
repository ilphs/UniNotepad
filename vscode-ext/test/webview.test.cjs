/**
 * Runs dist/webview.js in a jsdom window with a stubbed `acquireVsCodeApi`.
 *
 * Covers the mount handshake, the message dispatch in main.ts, the Markdown
 * branch of preview.ts (marked + DOMPurify), the settings mirror, and the zoom
 * ladder. It does NOT cover Mermaid SVG output: mermaid measures text with
 * getBBox/getComputedTextLength, which jsdom does not implement, so a diagram is
 * expected to land in the `.mermaid-error` path here. That the error path is
 * reached rather than an exception escaping is itself worth asserting.
 */
"use strict";
const fs = require("fs");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const CODE = fs.readFileSync(
  require("node:path").join(__dirname, "..", "dist", "webview.js"),
  "utf8",
);

const pass = [];
function ok(name) {
  pass.push(name);
  console.log("  ok  " + name);
}

function boot(bodyClass) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body class="${bodyClass}">` +
      `<div id="preview-host" data-source-uri="file:///tmp/t.md"></div></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const w = dom.window;
  const posted = [];
  let state = null;
  w.acquireVsCodeApi = () => ({
    postMessage: (m) => posted.push(m),
    getState: () => state,
    setState: (s) => {
      state = s;
    },
  });
  // jsdom leaves CSS.escape out; only the in-document anchor path uses it.
  if (!w.CSS) w.CSS = {};
  if (!w.CSS.escape) w.CSS.escape = (s) => String(s).replace(/["\\]/g, "\\$&");
  w.eval(CODE);
  return { w, posted, getState: () => state, host: w.document.getElementById("preview-host") };
}

/** The document the shell mounts against; `content` defaults to it so a test only
 *  names a URI when the point of the test is that the panel retargeted. */
const MOUNT_URI = "file:///tmp/t.md";

function send(w, msg) {
  if (msg.type === "content" && msg.uri === undefined) msg = { ...msg, uri: MOUNT_URI };
  // Dispatch directly rather than through window.postMessage: jsdom queues the
  // latter on its own task loop, and the extra indirection buys nothing here.
  const ev = new w.MessageEvent("message", { data: msg });
  w.dispatchEvent(ev);
}

const settle = () => new Promise((r) => setTimeout(r, 150));

(async () => {
  // ---- mount ----
  const { w, posted, getState, host } = boot("vscode-dark");
  assert.deepStrictEqual(
    posted.map((m) => m.type),
    ["ready"],
    "mount must post exactly one ready: " + JSON.stringify(posted),
  );
  ok("mount posts ready and nothing else");

  // Spread into this realm first: the object was built inside jsdom, so its
  // prototype is a different Object and deepStrictEqual would reject it on
  // identity alone.
  assert.deepStrictEqual({ ...getState() }, { uri: MOUNT_URI, zoomExp: 0 });
  ok("view state seeded with the source URI from the data attribute");

  assert.strictEqual(host.style.getPropertyValue("--preview-font-size"), "15px");
  assert.strictEqual(host.style.getPropertyValue("--mmd-zoom"), "1");
  assert.strictEqual(host.style.getPropertyValue("--mmd-bg"), "transparent");
  // Seeded before the host's first `settings` push, so this is the mirror's own
  // default rather than a configured value.
  assert.strictEqual(host.style.getPropertyValue("--md-col"), "680px");
  ok("host CSS variables seeded at 100% / transparent backdrop / default column");

  // ---- markdown render ----
  send(w, {
    type: "settings",
    settings: { mermaidBackground: "255,255,255,1", mermaidBackgroundEnabled: false },
  });
  send(w, {
    type: "content",
    fileType: "markdown",
    text: [
      "# Title",
      "",
      "Text with **bold**, a [link](https://example.com) and `code`.",
      "",
      "## Second",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "> quote",
    ].join("\n"),
  });
  await settle();

  const body = host.querySelector(".md-body");
  assert.ok(body, "no .md-body was created");
  ok(".md-body created on first render");

  assert.strictEqual(body.querySelector("h1").textContent, "Title");
  assert.strictEqual(body.querySelector("h2").textContent, "Second");
  assert.strictEqual(body.querySelectorAll("table").length, 1);
  assert.strictEqual(body.querySelectorAll("table td").length, 2);
  assert.strictEqual(body.querySelectorAll("blockquote").length, 1);
  assert.strictEqual(body.querySelector("strong").textContent, "bold");
  ok("GFM rendered: headings, table, blockquote, inline marks");

  const fence = body.querySelector("pre code");
  assert.ok(fence, "no fenced code block");
  assert.ok(/language-js/.test(fence.className), "fence lost its language class");
  assert.strictEqual(fence.textContent.trim(), "const x = 1;");
  ok("fenced code preserved with its language class");

  const link = body.querySelector("a[href]");
  assert.strictEqual(link.getAttribute("href"), "https://example.com");
  ok("links rendered");

  // ---- sanitization ----
  send(w, {
    type: "content",
    fileType: "markdown",
    text: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\n\n<div onclick="x">ok</div>',
  });
  await settle();
  const html = host.querySelector(".md-body").innerHTML;
  assert.ok(!/onerror/i.test(html), "onerror survived sanitization");
  assert.ok(!/onclick/i.test(html), "onclick survived sanitization");
  assert.ok(!/<script/i.test(html), "script tag survived sanitization");
  assert.strictEqual(w.__pwned, undefined, "injected script executed");
  ok("DOMPurify strips inline handlers and script tags");

  // ---- link interception ----
  send(w, { type: "content", fileType: "markdown", text: "[out](https://example.com/x) and [rel](./a.md)" });
  await settle();
  posted.length = 0;
  // VS Code's preload binds its own link handler to `window`; if a click reaches
  // it the host opens the link a second time, ignoring the trust prompt. Stand in
  // for that listener and assert nothing arrives.
  let reachedWindow = 0;
  w.addEventListener("click", () => reachedWindow++);
  const anchors = host.querySelectorAll(".md-body a[href]");
  for (const a of anchors) {
    a.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  assert.deepStrictEqual(
    posted.filter((m) => m.type === "openLink").map((m) => m.href),
    ["https://example.com/x", "./a.md"],
    "link clicks not forwarded: " + JSON.stringify(posted),
  );
  ok("link clicks forwarded to the host, absolute and relative alike");
  assert.strictEqual(reachedWindow, 0, "link click bubbled to window — VS Code would open it twice");
  ok("link clicks stop before window (no double-open past the trust prompt)");

  // ---- zoom ladder ----
  posted.length = 0;
  send(w, { type: "zoom", dir: 1 });
  assert.strictEqual(getState().zoomExp, 1);
  assert.strictEqual(host.style.getPropertyValue("--mmd-zoom"), "1.25");
  assert.strictEqual(host.style.getPropertyValue("--preview-font-size"), "18.75px");
  // The text column widens with the glyphs, or zooming in just reflows the same
  // paragraph into fewer words per line. 680 × 1.25.
  assert.strictEqual(host.style.getPropertyValue("--md-col"), "850px");
  assert.ok(host.classList.contains("mmd-zoomed"), "mmd-zoomed not applied off 100%");
  ok("zoom in scales diagrams, text, and the column together, and flags the host");

  send(w, { type: "zoom", dir: -1 });
  assert.strictEqual(getState().zoomExp, 0);
  assert.strictEqual(host.style.getPropertyValue("--mmd-zoom"), "1");
  assert.ok(!host.classList.contains("mmd-zoomed"), "mmd-zoomed must come off at exactly 100%");
  ok("stepping back lands on exactly 100% and drops the zoom rules");

  // The ladder's whole reason for existing: pressing past the ceiling must not
  // build a backlog that costs dead presses on the way down.
  for (let i = 0; i < 12; i++) send(w, { type: "zoom", dir: 1 });
  const cappedExp = getState().zoomExp;
  assert.ok(cappedExp <= 7, "exponent accumulated past the cap: " + cappedExp);
  assert.strictEqual(Number(host.style.getPropertyValue("--mmd-zoom")), 4);
  let presses = 0;
  while (Number(host.style.getPropertyValue("--mmd-zoom")) !== 1 && presses < 20) {
    send(w, { type: "zoom", dir: -1 });
    presses++;
  }
  assert.strictEqual(Number(host.style.getPropertyValue("--mmd-zoom")), 1, "never returned to 100%");
  assert.ok(presses <= 8, "took " + presses + " presses to get back to 100%");
  ok("zoom clamps at 400% without a backlog and walks back to exactly 100% (" + presses + " presses)");

  send(w, { type: "zoom", dir: 0 });
  assert.strictEqual(getState().zoomExp, 0);
  ok("zoom reset returns to 100%");

  // ---- backdrop settings ----
  posted.length = 0;
  send(w, {
    type: "settings",
    settings: { mermaidBackground: "10,20,30,0.5", mermaidBackgroundEnabled: true },
  });
  assert.strictEqual(host.style.getPropertyValue("--mmd-bg"), "rgba(10, 20, 30, 0.5)");
  ok("backdrop setting repaints --mmd-bg without a re-render");

  send(w, { type: "settings", settings: { mermaidBackground: "garbage", mermaidBackgroundEnabled: true } });
  assert.strictEqual(
    host.style.getPropertyValue("--mmd-bg"),
    "rgba(255, 255, 255, 1)",
    "a malformed setting must fall back to the whole default tuple",
  );
  ok("malformed backdrop falls back to the default tuple");

  // ---- text column width ----
  // A settings push repaints the column without a re-render, the same way the
  // backdrop does — both are CSS variables on the host.
  send(w, {
    type: "settings",
    settings: { mermaidBackground: "255,255,255,1", mermaidBackgroundEnabled: false, contentWidth: 1200 },
  });
  assert.strictEqual(host.style.getPropertyValue("--md-col"), "1200px");
  ok("contentWidth setting repaints --md-col without a re-render");

  // 0 is "fill the panel", and it has to reach CSS as `none`: `max-width: 0`
  // would collapse the column to nothing.
  send(w, {
    type: "settings",
    settings: { mermaidBackground: "255,255,255,1", mermaidBackgroundEnabled: false, contentWidth: 0 },
  });
  assert.strictEqual(host.style.getPropertyValue("--md-col"), "none");
  ok("contentWidth 0 becomes `none`, not `0px`");

  // settings.json is hand-editable and the field is optional on the wire, so a
  // junk or absent value must land on the default — never on 0, which would
  // silently reflow the whole document.
  send(w, {
    type: "settings",
    settings: { mermaidBackground: "255,255,255,1", mermaidBackgroundEnabled: false, contentWidth: -50 },
  });
  assert.strictEqual(host.style.getPropertyValue("--md-col"), "680px");
  send(w, {
    type: "settings",
    settings: { mermaidBackground: "255,255,255,1", mermaidBackgroundEnabled: false },
  });
  assert.strictEqual(host.style.getPropertyValue("--md-col"), "680px");
  ok("invalid or absent contentWidth falls back to the default column");

  // ---- requestHtml round-trip ----
  send(w, { type: "content", fileType: "markdown", text: "# Export me" });
  await settle();
  posted.length = 0;
  send(w, { type: "requestHtml", token: 7 });
  const reply = posted.find((m) => m.type === "html");
  assert.ok(reply, "no html reply");
  assert.strictEqual(reply.token, 7, "token not echoed");
  assert.ok(/<h1>Export me<\/h1>/.test(reply.html), "reply did not carry the rendered body");
  ok("requestHtml replies with the rendered body and echoes the token");

  // ---- mermaid: solo class + graceful failure under jsdom ----
  send(w, { type: "content", fileType: "mermaid", text: "graph TD\n A-->B" });
  await settle();
  assert.ok(host.classList.contains("mmd-solo"), "a standalone diagram must go full-bleed");
  ok("mermaid document sets the solo layout");

  const soloBody = host.querySelector(".md-body");
  const failed = soloBody.querySelector(".mermaid-error");
  const rendered = soloBody.querySelector(".mermaid-diagram svg");
  assert.ok(failed || rendered, "mermaid neither rendered nor reported an error");
  assert.strictEqual(
    soloBody.querySelectorAll("code.language-mermaid").length,
    0,
    "the mermaid source block was left in place",
  );
  ok(
    "mermaid block consumed (" +
      (rendered ? "rendered" : "error path — expected under jsdom") +
      ")",
  );

  send(w, { type: "content", fileType: "markdown", text: "# back to text" });
  await settle();
  assert.ok(!host.classList.contains("mmd-solo"), "solo class must come back off");
  ok("switching back to Markdown clears the solo layout");

  // ---- retarget: the panel followed the editor to a different document ----
  // jsdom has no layout, so scrollTop is inert there. Back it with a real field:
  // the assertion is about this code deciding to reset, not about a browser
  // honouring the assignment.
  let scrollTop = 0;
  Object.defineProperty(host, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v) => {
      scrollTop = v;
    },
  });

  scrollTop = 120;
  send(w, { type: "content", fileType: "markdown", text: "# same file, edited" });
  await settle();
  assert.strictEqual(scrollTop, 120, "an edit to the same document must not jump the reader");
  assert.strictEqual(getState().uri, MOUNT_URI, "an edit must not change the persisted URI");
  ok("re-push of the same document keeps scroll and URI");

  send(w, { type: "content", fileType: "markdown", text: "# other file", uri: "file:///tmp/other.md" });
  await settle();
  assert.strictEqual(scrollTop, 0, "switching documents must return to the top");
  ok("retarget to a different document resets the scroll");

  // Load-bearing for the serializer: the shell is not rebuilt on a retarget, so
  // the stale data-source-uri would restore the wrong document after a reload.
  assert.deepStrictEqual(
    { ...getState() },
    { uri: "file:///tmp/other.md", zoomExp: 0 },
    "the persisted view state must follow the panel's new target",
  );
  ok("retarget re-stamps the persisted source URI");

  // ---- theme detection ----
  const light = boot("vscode-light");
  assert.deepStrictEqual(light.posted.map((m) => m.type), ["ready"]);
  ok("mounts under the light theme class too");

  console.log("\n" + pass.length + " checks passed");
})().catch((e) => {
  console.error("\nFAILED: " + e.message);
  console.error(e.stack);
  process.exit(1);
});
