/**
 * Theme state on two independent axes:
 *
 *   uninotepad.theme      → family  ("dracula" | "github" | ...)  — the palette
 *   uninotepad.themeMode  → mode    ("dark" | "light" | "system") — the contrast
 *
 * The two are composed into a single attribute, `<html data-theme="dracula-dark">`,
 * which `themes.css` keys its 20 palette blocks off. Everything downstream
 * (tab bar, status bar, Markdown preview, CodeMirror chrome and token colors)
 * reads CSS variables, so switching a theme is one attribute write — no
 * CodeMirror reconfiguration, no re-render.
 *
 * **"system" never reaches CSS.** It is resolved here via `matchMedia` and
 * written out as a concrete dark/light value. That is deliberate: the previous
 * design let a `@media (prefers-color-scheme: dark)` block mirror the dark
 * palette by hand, which with 10 families would have meant maintaining 10
 * duplicated blocks. Resolving in JS keeps `themes.css` at exactly 20 blocks
 * and makes the OS listener below the single place live switching happens.
 */
import {
  DEFAULT_FAMILY,
  DEFAULT_MODE,
  isThemeFamily,
  isThemeMode,
  type ResolvedMode,
  type ThemeFamily,
  type ThemeMode,
} from "./themes";
import { syncThemeMenu } from "./ipc";

const FAMILY_KEY = "uninotepad.theme";
const MODE_KEY = "uninotepad.themeMode";

/** Held in a module constant rather than re-queried per call: a MediaQueryList
 *  with no live reference has been collected by some WebKit builds, silently
 *  killing its listener. That used to be harmless because CSS drove "system";
 *  now this object is the only thing that makes it live. */
const OS_DARK = matchMedia("(prefers-color-scheme: dark)");

/** How the pre-2-axis single-axis values map onto (family, mode). Chosen for
 *  visual continuity: the old "dark" palette *was* Dracula, and the old "light"
 *  palette was GitHub Light in all but name. See design §5. */
const LEGACY: Record<string, { family: ThemeFamily; mode: ThemeMode }> = {
  dark: { family: "dracula", mode: "dark" },
  light: { family: "github", mode: "light" },
  // The one visible change: under "system", light used to mean GitHub Light and
  // now means Dracula Light. Keeping the family at Dracula matches the app's
  // identity and keeps the dark half pixel-identical. Noted in the release notes.
  system: { family: "dracula", mode: "system" },
};

/** Persisted family, defaulting for any missing/unknown value. */
export function themeFamily(): ThemeFamily {
  const v = localStorage.getItem(FAMILY_KEY);
  return isThemeFamily(v) ? v : DEFAULT_FAMILY;
}

/** Persisted mode, defaulting for any missing/unknown value. */
export function themeMode(): ThemeMode {
  const v = localStorage.getItem(MODE_KEY);
  return isThemeMode(v) ? v : DEFAULT_MODE;
}

/** The mode actually in effect: "system" resolved against the OS preference. */
export function resolvedMode(): ResolvedMode {
  const m = themeMode();
  if (m !== "system") return m;
  return OS_DARK.matches ? "dark" : "light";
}

/** Write the composed attribute. The only place `data-theme` is assigned. */
function apply(): void {
  document.documentElement.dataset.theme = `${themeFamily()}-${resolvedMode()}`;
}

/** Notify theme-dependent views (the Markdown preview re-renders mermaid
 *  diagrams, whose colors are baked into the generated SVG). */
function announce(): void {
  window.dispatchEvent(new Event("uninotepad:themechange"));
}

/** One-time upgrade of the old single-axis `uninotepad.theme` value. Both keys
 *  are rewritten so the migration runs exactly once: afterwards the stored
 *  family is a real family id and the normal read path takes over.
 *
 *  Detection is "the family key holds a legacy value" rather than a version
 *  flag — the legacy values ("light"/"dark"/"system") are disjoint from every
 *  family id, so there is no ambiguity and no extra key to maintain. */
function migrateLegacy(): void {
  const raw = localStorage.getItem(FAMILY_KEY);
  if (raw === null || isThemeFamily(raw)) return;
  // An own-property test, not a plain lookup: "constructor"/"toString"/"valueOf"
  // would find Object.prototype members, make a ?? fallback look satisfied, and
  // write the string "undefined" into both keys. (Object.hasOwn would say this
  // more directly but needs a newer lib target than this project sets.)
  const next = Object.prototype.hasOwnProperty.call(LEGACY, raw)
    ? LEGACY[raw]
    : { family: DEFAULT_FAMILY, mode: DEFAULT_MODE };
  localStorage.setItem(FAMILY_KEY, next.family);
  localStorage.setItem(MODE_KEY, next.mode);
}

let osListenerBound = false;

/** Track OS light/dark changes so "system" switches live. The listener stays
 *  bound for the process lifetime and checks the mode when it fires, rather
 *  than being attached/detached as the mode changes — one less piece of state
 *  to get wrong, and the handler is a no-op outside "system". */
function bindOsListener(): void {
  if (osListenerBound) return;
  osListenerBound = true;
  OS_DARK.addEventListener("change", () => {
    if (themeMode() !== "system") return;
    apply();
    announce();
  });
}

/** Apply the persisted theme. Called from `main.ts` at import time, i.e. as
 *  early as a deferred module script can run. A frame painted before that falls
 *  back to the bare `:root` block in themes.css (the default dracula-dark), so
 *  the worst case is one frame of the default palette rather than an unstyled
 *  page — never a *wrong* palette that then snaps. */
export function applyStoredTheme(): void {
  migrateLegacy();
  bindOsListener();
  apply();
  // Push the stored selection into the native menu's check marks. Rust builds
  // the submenu with the defaults checked because it cannot read localStorage,
  // so without this a user who picked, say, Nord + Light would still see
  // Dracula + Dark ticked. Same reason set_recent_files is called once at
  // startup. Best-effort, so running before first paint is fine.
  //
  // The *stored* mode is sent, "system" included — the menu shows the axis
  // value the user chose, not resolvedMode()'s dark/light interpretation of it.
  syncThemeMenu(themeFamily(), themeMode());
}

/** Persist and apply a new family, keeping the current mode. */
export function setThemeFamily(family: ThemeFamily): void {
  localStorage.setItem(FAMILY_KEY, family);
  commit();
}

/** Persist and apply a new mode, keeping the current family. "system" is stored
 *  explicitly (not cleared) so it survives the dark default. */
export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(MODE_KEY, mode);
  commit();
}

/** Shared tail of both setters: repaint, notify listeners, and push the new
 *  selection back to the native menu so its check marks match — the menu is not
 *  the only entry point (Preferences has the same two controls). */
function commit(): void {
  apply();
  announce();
  syncThemeMenu(themeFamily(), themeMode());
}
