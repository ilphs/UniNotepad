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
} from "./tabs";
import { store } from "./state";
import { openSaveOptions, openRecentDialog } from "./dialogs";
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
    case "file.save":
      saveActive();
      break;
    case "file.saveAs":
      saveActiveAs();
      break;
    case "file.saveAll":
      void saveAll();
      break;
    case "file.saveOptions":
      openSaveOptions();
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
    // editor font. The fork has to live on the *menu* path, not on keydown:
    // Cmd/Ctrl+= / - / 0 are native accelerators (src-tauri/src/menu.rs), and on
    // Windows tao's msg_hook runs TranslateAcceleratorW first and only calls
    // DispatchMessageW `if (!handled)`, so the WebView never sees those keys at
    // all — a keydown-based fork would be dead code there. macOS is the mirror
    // image: WKWebView sees the key first and would starve the menu if it
    // preventDefault'd. The menu event is the one path all three OSes share.
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
  }
}
