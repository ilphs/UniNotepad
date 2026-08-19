/**
 * Built-in theme registry — the single source of truth for the *theme* axis.
 *
 * The palette itself lives entirely in CSS (`src/themes.css`, one
 * `:root[data-theme="<family>-<dark|light>"]` block per combination), so this
 * module carries no colors: only the ids and the human labels the UI needs
 * (Preferences dropdown, native View → Theme submenu). Adding a family means
 * adding two CSS blocks plus one entry here — no CodeMirror wiring, because
 * `language.ts` resolves every token color through `var(--cm-*)`.
 *
 * The declaration order below is the order shown in the UI and must stay in
 * sync with the native menu built in `src-tauri/src/menu.rs`; the menu ids are
 * derived mechanically as `view.theme.<id>`.
 *
 * ⚠ "Dracula Light" is NOT an official Dracula palette. Dracula's own light
 * counterpart (Alucard) ships only with the paid Dracula PRO product and is
 * absent from the public spec, so it cannot be bundled. Our light variant is a
 * self-derived reinterpretation that keeps Dracula's six accent hues and
 * re-tunes lightness/saturation for a light background. Every other family
 * pairs two officially published dark/light palettes.
 */

/** A theme family id. Combined with a resolved mode it forms `data-theme`. */
export type ThemeFamily =
  | "dracula"
  | "github"
  | "solarized"
  | "gruvbox"
  | "catppuccin"
  | "nord"
  | "tokyo-night"
  | "one-half"
  | "rose-pine"
  | "kanagawa";

/** The contrast axis as the *user* picks it. "system" defers to the OS. */
export type ThemeMode = "dark" | "light" | "system";

/** The contrast axis after "system" has been resolved via `matchMedia`. This is
 *  the only form that ever reaches `data-theme` — CSS never sees "system". */
export type ResolvedMode = "dark" | "light";

/** A registry entry. Deliberately minimal: both modes exist for every family,
 *  so there is nothing per-family to configure beyond id and label. */
export interface ThemeDef {
  /** Stored in localStorage and embedded in `data-theme` / native menu ids. */
  id: ThemeFamily;
  /** Display name for the Preferences dropdown and the native menu. */
  label: string;
}

/** The ten bundled families, in display order. */
export const THEMES: readonly ThemeDef[] = [
  { id: "dracula", label: "Dracula" },
  { id: "github", label: "GitHub" },
  { id: "solarized", label: "Solarized" },
  { id: "gruvbox", label: "Gruvbox" },
  { id: "catppuccin", label: "Catppuccin" },
  { id: "nord", label: "Nord" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "one-half", label: "One Half" },
  { id: "rose-pine", label: "Rosé Pine" },
  { id: "kanagawa", label: "Kanagawa" },
];

/** Default family. Matches the pre-2-axis default palette (Dracula dark), so an
 *  existing user who never touched the setting sees no pixel change. */
export const DEFAULT_FAMILY: ThemeFamily = "dracula";

/** Default contrast. See {@link DEFAULT_FAMILY} — the old default was "dark". */
export const DEFAULT_MODE: ThemeMode = "dark";

/** Narrow an untrusted value (localStorage, a native menu id suffix) to a known
 *  family. Unknown ids must fall back rather than reach `data-theme`, where they
 *  would match no CSS block and leave the app unstyled. */
export function isThemeFamily(v: unknown): v is ThemeFamily {
  return typeof v === "string" && THEMES.some((t) => t.id === v);
}

/** Narrow an untrusted value to a mode. Mirrors {@link isThemeFamily}. */
export function isThemeMode(v: unknown): v is ThemeMode {
  return v === "dark" || v === "light" || v === "system";
}
