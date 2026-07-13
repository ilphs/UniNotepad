import { doUndo, doRedo, openFind, zoomIn, zoomOut, zoomReset } from "./editor";
import { newUntitled, openDialog, saveActive, saveActiveAs, closeActive } from "./tabs";

/** Map a native-menu item id (from the `menu` event) to a frontend action. */
export function handleMenu(id: string): void {
  switch (id) {
    case "file.new":
      newUntitled();
      break;
    case "file.open":
      void openDialog();
      break;
    case "file.save":
      saveActive();
      break;
    case "file.saveAs":
      saveActiveAs();
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
    case "edit.replace":
      openFind();
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
  }
}
