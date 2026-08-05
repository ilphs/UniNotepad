/**
 * The webview's view of the extension's settings.
 *
 * Ported from the app's `src/settings.ts`, with localStorage swapped for a
 * host-owned cache: reads hit a local mirror (synchronous, which is what the
 * paint path needs), writes go out as a `setSetting` message and come back as a
 * `settings` push. That round-trip means a write is *not* observable on the next
 * read — so every setter also updates the mirror locally, exactly as a
 * write-through cache would.
 *
 * The parse/clamp/fallback logic is kept verbatim from the app on purpose: a
 * user can hand-edit `uninotepadPreview.mermaidBackground` in settings.json, so
 * a malformed "r,g,b,a" is just as reachable here as a malformed localStorage
 * value was there, and the whole-tuple fallback (never per channel) is what stops
 * a half-parsed record from painting a color nobody chose.
 */
import type { PreviewSettings } from "../shared/protocol";
import { post } from "./host";

/** Backdrop painted behind every rendered Mermaid diagram: 8-bit RGB channels
 *  plus a 0–1 opacity. Consumed by mermaid-view.ts as an `--mmd-bg` rgba(). */
export interface MermaidBg {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** White at full opacity: the useful starting point, since the backdrop mainly
 *  exists to rescue a light diagram viewed under a dark theme. */
const MERMAID_BG_DEFAULT: MermaidBg = { r: 255, g: 255, b: 255, a: 1 };

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clampAlpha(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Preview text-column bounds (px at 100% zoom), mirroring the app's
 *  settings.ts. 0 is a distinct value rather than the bottom of the range: it
 *  means "no cap", so the floor applies only to nonzero values. */
const CONTENT_WIDTH_MIN = 320;
const CONTENT_WIDTH_MAX = 3000;
const CONTENT_WIDTH_DEFAULT = 680;

let mirror: PreviewSettings = {
  mermaidBackground: "255,255,255,1",
  mermaidBackgroundEnabled: false,
  contentWidth: CONTENT_WIDTH_DEFAULT,
};

/** Adopt a `settings` push from the host. */
export function applySettings(next: PreviewSettings): void {
  mirror = next;
}

/** Whether the backdrop is painted at all. Kept separate from `a === 0` on
 *  purpose: folding "transparent" into the alpha would destroy the opacity the
 *  user picked every time they toggled the backdrop off and back on. */
export function mermaidBgEnabled(): boolean {
  return mirror.mermaidBackgroundEnabled;
}

export function setMermaidBgEnabled(on: boolean): void {
  mirror = { ...mirror, mermaidBackgroundEnabled: on };
  post({ type: "setSetting", key: "mermaidBackgroundEnabled", value: on });
}

/**
 * Width cap for the text column, in px at 100% zoom; 0 means "fill the panel".
 *
 * `contentWidth` is optional on the wire, and settings.json is hand-editable, so
 * every non-integer, negative, or absent value has to land on the default rather
 * than on 0 — reading a typo as "no cap" would silently change the layout.
 */
export function previewContentWidth(): number {
  const v = mirror.contentWidth;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return CONTENT_WIDTH_DEFAULT;
  if (v === 0) return 0;
  return Math.max(CONTENT_WIDTH_MIN, Math.min(CONTENT_WIDTH_MAX, v));
}

/** The stored backdrop color, or the default if anything about the stored
 *  "r,g,b,a" is off. Note the empty-part check: `Number("")` is 0, which would
 *  otherwise read as a valid channel. */
export function mermaidBg(): MermaidBg {
  const raw = mirror.mermaidBackground;
  if (!raw) return { ...MERMAID_BG_DEFAULT };
  const parts = raw.split(",");
  if (parts.length !== 4) return { ...MERMAID_BG_DEFAULT };
  const n = parts.map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (n.some((v) => !Number.isFinite(v))) return { ...MERMAID_BG_DEFAULT };
  return {
    r: clampChannel(n[0]),
    g: clampChannel(n[1]),
    b: clampChannel(n[2]),
    a: clampAlpha(n[3]),
  };
}

export function setMermaidBg(bg: MermaidBg): void {
  const v = [clampChannel(bg.r), clampChannel(bg.g), clampChannel(bg.b), clampAlpha(bg.a)];
  const serialized = v.join(",");
  mirror = { ...mirror, mermaidBackground: serialized };
  post({ type: "setSetting", key: "mermaidBackground", value: serialized });
}
