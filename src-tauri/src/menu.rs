//! Native application menu. Clicks on custom items emit a `menu` event to the
//! webview carrying the item id (e.g. "file.save"); the frontend maps ids to
//! actions. Editing/clipboard items use Tauri predefined items so the OS drives
//! them against the focused WebView natively.

use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // File
    let new_tab = MenuItemBuilder::with_id("file.new", "New Tab")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open = MenuItemBuilder::with_id("file.open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("file.save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("file.saveAs", "Save As…")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("file.close", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&open)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&close_tab)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit UniEdit"))?)
        .build()?;

    // Edit — undo/redo are custom (must drive CodeMirror history), the rest are
    // predefined so native clipboard handling applies to the WebView.
    let undo = MenuItemBuilder::with_id("edit.undo", "Undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::with_id("edit.redo", "Redo")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let find = MenuItemBuilder::with_id("edit.find", "Find…")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;
    let replace = MenuItemBuilder::with_id("edit.replace", "Replace…")
        .accelerator("CmdOrCtrl+H")
        .build(app)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("Cut"))?)
        .item(&PredefinedMenuItem::copy(app, Some("Copy"))?)
        .item(&PredefinedMenuItem::paste(app, Some("Paste"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("Select All"))?)
        .separator()
        .item(&find)
        .item(&replace)
        .build()?;

    // View — zoom
    let zoom_in = MenuItemBuilder::with_id("view.zoomIn", "Zoom In")
        .accelerator("CmdOrCtrl+Plus")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("view.zoomOut", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("view.zoomReset", "Reset Zoom")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;

    Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu])
}
