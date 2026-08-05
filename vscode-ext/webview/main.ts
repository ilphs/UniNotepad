/**
 * Webview entry point: mount the preview, then sit on the message channel.
 *
 * The `ready` message is the handshake that matters. Assigning `webview.html`
 * resets all script state, so anything the host posts before this listener exists
 * is dropped on the floor — the host therefore holds the first `content` until
 * `ready` arrives.
 */
import { initState, post } from "./host";
import { applySettings } from "./settings";
import { applyMermaidBg, handleZoom } from "./mermaid-view";
import {
  applyPreviewZoom,
  mountPreview,
  renderedHtml,
  setContent,
  setScrollFraction,
} from "./preview";
import type { HostToWebview } from "../shared/protocol";

const host = document.getElementById("preview-host");
if (!host) throw new Error("#preview-host missing from the webview shell");

initState(host.dataset.sourceUri ?? "");
mountPreview(host);

window.addEventListener("message", (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  switch (msg.type) {
    case "content":
      setContent(msg.text, msg.fileType, msg.uri);
      return;
    case "scroll":
      setScrollFraction(msg.fraction);
      return;
    case "zoom":
      handleZoom(msg.dir);
      return;
    case "settings":
      applySettings(msg.settings);
      // Repaint rather than re-render: both the backdrop and the text-column cap
      // are CSS variables on the host, which is the entire point of that design
      // (see mermaid-view.ts). applyPreviewZoom re-derives `--md-col` from the
      // new setting at the current zoom factor.
      applyMermaidBg();
      applyPreviewZoom();
      return;
    case "requestHtml":
      post({ type: "html", token: msg.token, html: renderedHtml() });
      return;
  }
});

post({ type: "ready" });
