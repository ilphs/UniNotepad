/**
 * The webview's single channel to the extension host, plus the persisted view
 * state that rides on it.
 *
 * `acquireVsCodeApi()` may be called exactly once per webview session, so it is
 * called here and nowhere else; every other module imports `post` / the state
 * helpers instead of reaching for the global.
 *
 * View state (`{ uri, zoomExp }`) is what a `WebviewPanelSerializer` gets back
 * after a window reload. `uri` is the load-bearing half — without it the host
 * cannot tell which document a restored panel belongs to — and it is read out of
 * a data attribute on `#preview-host` rather than an inline script, so the CSP
 * script policy can stay nonce-only.
 */
import type { WebviewToHost } from "../shared/protocol";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

export function post(msg: WebviewToHost): void {
  api.postMessage(msg);
}

export interface ViewState {
  /** Source document URI. Seeded at mount from the host-rendered attribute, then
   *  re-stamped by `setUri` every time the panel follows the editor to a
   *  different document — the shell is not rebuilt on a retarget, so without this
   *  a reload would restore the panel against whichever file it opened on. */
  uri: string;
  /** Preview zoom held as an exponent — see mermaid-view.ts for why not a factor. */
  zoomExp: number;
}

let state: ViewState = { uri: "", zoomExp: 0 };

/** Seed from whatever survived a reload, then overwrite `uri` from the DOM: the
 *  host re-renders the shell on restore, so the attribute is always current
 *  while a persisted `uri` could be from an older panel identity. */
export function initState(sourceUri: string): void {
  const saved = api.getState() as Partial<ViewState> | null;
  state = {
    uri: sourceUri,
    zoomExp: typeof saved?.zoomExp === "number" && Number.isFinite(saved.zoomExp) ? saved.zoomExp : 0,
  };
  api.setState(state);
}

export function sourceUri(): string {
  return state.uri;
}

export function setSourceUri(uri: string): void {
  if (uri === state.uri) return;
  state.uri = uri;
  api.setState(state);
}

export function zoomExp(): number {
  return state.zoomExp;
}

export function setZoomExp(exp: number): void {
  state.zoomExp = exp;
  api.setState(state);
}
