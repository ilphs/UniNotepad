/**
 * turndown-plugin-gfm ships no types. Only the pieces this app uses are declared
 * here — `gfm` is the bundle of the four rule sets, which is what html-to-markdown
 * hands to `TurndownService.use()`.
 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  type Plugin = (service: TurndownService) => void;

  export const gfm: Plugin;
  export const tables: Plugin;
  export const strikethrough: Plugin;
  export const taskListItems: Plugin;
  export const highlightedCodeBlock: Plugin;
}
