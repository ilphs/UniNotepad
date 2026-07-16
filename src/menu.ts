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
} from "./editor";
import {
  newUntitled,
  openDialog,
  saveActive,
  saveActiveAs,
  closeActive,
  reopenClosed,
  activateTabByIndex,
  activateLastTab,
} from "./tabs";
import { openSaveOptions, openRecentDialog } from "./dialogs";
import { setTheme } from "./theme";
import { togglePreview } from "./preview";
import { handleZoomShortcut } from "./mermaid-view";

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
    case "file.saveOptions":
      openSaveOptions();
      break;
    case "file.reopenClosed":
      void reopenClosed();
      break;
    case "file.close":
      closeActive();
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
    case "view.togglePreview":
      togglePreview();
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
  }
}
