/**
 * Manual theme selection. The choice ("light" | "dark" | "system") is persisted
 * in localStorage. "system" removes the `data-theme` attribute so the CSS
 * `prefers-color-scheme` media query follows the OS live; "light"/"dark" set the
 * attribute to override it. See styles.css for the palettes.
 *
 * The default (no stored choice) is "dark". Every explicit choice — including
 * "system" — is persisted so the default never overrides a deliberate pick.
 */
export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "uninotepad.theme";

/** Persisted choice, defaulting to "dark" for any missing/invalid value. */
export function themeChoice(): ThemeChoice {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "dark";
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** Apply the persisted choice. Call once at startup. */
export function applyStoredTheme(): void {
  apply(themeChoice());
}

/** Persist and apply a new theme choice (invoked from the View → Theme menu).
 *  "system" is stored explicitly (not cleared) so it survives the dark default. */
export function setTheme(choice: ThemeChoice): void {
  localStorage.setItem(STORAGE_KEY, choice);
  apply(choice);
  // Let theme-dependent views (e.g. the Markdown preview's mermaid diagrams)
  // re-render for the new palette.
  window.dispatchEvent(new Event("uninotepad:themechange"));
}
