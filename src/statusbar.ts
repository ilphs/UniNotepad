import { store } from "./state";
import { getView, getZoomPercent } from "./editor";

let el: HTMLElement;

export function initStatusBar(host: HTMLElement): void {
  el = host;
}

function eolLabel(eol: string): string {
  return eol === "crlf" ? "CRLF" : "LF";
}

function encLabel(enc: string): string {
  switch (enc) {
    case "utf8bom":
      return "UTF-8-BOM";
    case "latin1":
      return "Latin-1";
    default:
      return "UTF-8";
  }
}

export function refreshStatusBar(): void {
  if (!el) return;
  const tab = store.activeTab;
  if (!tab) {
    el.replaceChildren();
    return;
  }
  const state = getView().state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const col = head - line.from + 1;
  const sel = state.selection.main;
  const selInfo = sel.empty ? "" : `  (${sel.to - sel.from} sel)`;

  const left = document.createElement("span");
  left.textContent = `Ln ${line.number}, Col ${col}${selInfo}`;

  const right = document.createElement("span");
  right.className = "status-right";
  right.textContent = `${getZoomPercent()}%   ${eolLabel(tab.eol)}   ${encLabel(tab.encoding)}`;

  el.replaceChildren(left, right);
}
