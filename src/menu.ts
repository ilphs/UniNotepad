import {
  doUndo,
  doRedo,
  openFind,
  openReplace,
  findNextMatch,
  findPrevMatch,
  zoomIn,
  zoomOut,
  zoomReset,
  openGotoLine,
  toggleWordWrap,
  toggleShowWhitespace,
  toggleLineNumbers,
  selectNextOccurrenceCmd,
  foldAll,
  unfoldAll,
} from "./editor";
import {
  newUntitled,
  openDialog,
  saveActive,
  saveActiveAs,
  saveAll,
  closeActive,
  closeOthers,
  closeTabsToRight,
  closeAll,
  reopenClosed,
  activateTabByIndex,
  activateLastTab,
  cycleTab,
  setActiveEol,
  openPath,
} from "./tabs";
import { store } from "./state";
import { openRecentDialog, openAbout } from "./dialogs";
import { checkForUpdates } from "./updater";
import { openPreferences } from "./preferences";
import { clearRecent } from "./recent";
import { setTheme } from "./theme";
import { togglePreview, exportPreviewHtml, printPreview } from "./preview";
import { handleZoomShortcut } from "./mermaid-view";
import {
  sortLinesAsc,
  sortLinesDesc,
  removeDuplicateLines,
  removeEmptyLines,
  trimTrailingWhitespace,
  toUpperCase,
  toLowerCase,
  moveLineUp,
  moveLineDown,
} from "./lineops";

/** Map a native-menu item id (from the `menu` event) to a frontend action. */
export function handleMenu(id: string): void {
  // Native "Open Recent" submenu entries carry the full path in their id
  // (file.recent:<path>) — muda allows an arbitrary String MenuId. Handle the
  // prefix before the fixed-id switch below.
  if (id.startsWith("file.recent:")) {
    void openPath(id.slice("file.recent:".length));
    return;
  }
  switch (id) {
    case "file.new":
      newUntitled();
      break;
    case "file.open":
      void openDialog();
      break;
    case "file.openRecent":
      openRecentDialog();
      break;
    case "file.clearRecent":
      clearRecent();
      break;
    case "app.preferences":
      openPreferences();
      break;
    case "file.save":
      saveActive();
      break;
    case "file.saveAs":
      saveActiveAs();
      break;
    case "file.saveAll":
      void saveAll();
      break;
    case "file.exportHtml":
      void exportPreviewHtml();
      break;
    case "file.print":
      printPreview();
      break;
    case "file.reopenClosed":
      void reopenClosed();
      break;
    case "file.close":
      closeActive();
      break;
    case "file.closeOthers": {
      const id = store.activeTab?.id;
      if (id) closeOthers(id);
      break;
    }
    case "file.closeRight": {
      const id = store.activeTab?.id;
      if (id) closeTabsToRight(id);
      break;
    }
    case "file.closeAll":
      closeAll();
      break;
    case "edit.undo":
      doUndo();
      break;
    case "edit.redo":
      doRedo();
      break;
    case "edit.find":
      openFind();
      break;
    case "edit.replace":
      openReplace();
      break;
    case "edit.selectNextOccurrence":
      selectNextOccurrenceCmd();
      break;
    case "edit.sortAsc":
      sortLinesAsc();
      break;
    case "edit.sortDesc":
      sortLinesDesc();
      break;
    case "edit.removeDuplicate":
      removeDuplicateLines();
      break;
    case "edit.removeEmpty":
      removeEmptyLines();
      break;
    case "edit.trimTrailing":
      trimTrailingWhitespace();
      break;
    case "edit.toUpper":
      toUpperCase();
      break;
    case "edit.toLower":
      toLowerCase();
      break;
    case "edit.moveLineUp":
      moveLineUp();
      break;
    case "edit.moveLineDown":
      moveLineDown();
      break;
    case "edit.findNext":
      findNextMatch();
      break;
    case "edit.findPrev":
      findPrevMatch();
      break;
    case "view.gotoLine":
      openGotoLine();
      break;
    case "view.toggleWrap":
      toggleWordWrap();
      break;
    case "view.toggleWhitespace":
      toggleShowWhitespace();
      break;
    case "view.toggleLineNumbers":
      toggleLineNumbers();
      break;
    case "view.foldAll":
      foldAll();
      break;
    case "view.unfoldAll":
      unfoldAll();
      break;
    case "view.togglePreview":
      togglePreview();
      break;
    case "view.eolLf":
      void setActiveEol("lf");
      break;
    case "view.eolCrlf":
      void setActiveEol("crlf");
      break;
    // Zoom forks here — pointing at a diagram scales the chart, otherwise the
    // editor font. The fork lives on the *menu-id* path rather than in a raw
    // keydown handler so every entry point shares it: native accelerators and
    // menu clicks (macOS/Linux), and the Windows keydown fallback in main.ts —
    // there WebView2 pumps keyboard input in its own child HWND, the host loop
    // never sees the keys while the editor has focus, and native accelerators
    // never fire, so main.ts replays them as handleMenu(id) calls into this
    // same switch. The menu id is the one path all three OSes share.
    case "view.zoomIn":
      if (!handleZoomShortcut(1)) zoomIn();
      break;
    case "view.zoomOut":
      if (!handleZoomShortcut(-1)) zoomOut();
      break;
    case "view.zoomReset":
      if (!handleZoomShortcut(0)) zoomReset();
      break;
    case "view.themeLight":
      setTheme("light");
      break;
    case "view.themeDark":
      setTheme("dark");
      break;
    case "view.themeSystem":
      setTheme("system");
      break;
    case "view.gotoTab1": activateTabByIndex(0); break;
    case "view.gotoTab2": activateTabByIndex(1); break;
    case "view.gotoTab3": activateTabByIndex(2); break;
    case "view.gotoTab4": activateTabByIndex(3); break;
    case "view.gotoTab5": activateTabByIndex(4); break;
    case "view.gotoTab6": activateTabByIndex(5); break;
    case "view.gotoTab7": activateTabByIndex(6); break;
    case "view.gotoTab8": activateTabByIndex(7); break;
    case "view.gotoTab9": activateLastTab(); break;
    case "view.nextTab": cycleTab(1); break;
    case "view.prevTab": cycleTab(-1); break;
    case "help.about": openAbout(); break;
    case "help.checkUpdates": void checkForUpdates(true); break;
  }
}
