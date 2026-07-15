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
    case "view.zoomIn":
      zoomIn();
      break;
    case "view.zoomOut":
      zoomOut();
      break;
    case "view.zoomReset":
      zoomReset();
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
