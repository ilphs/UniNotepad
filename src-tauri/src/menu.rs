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
    let open_recent = MenuItemBuilder::with_id("file.openRecent", "Open Recent…").build(app)?;
    let save = MenuItemBuilder::with_id("file.save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("file.saveAs", "Save As…")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let save_options = MenuItemBuilder::with_id("file.saveOptions", "Save Options…").build(app)?;
    let reopen_closed = MenuItemBuilder::with_id("file.reopenClosed", "Reopen Closed Tab")
        .accelerator("CmdOrCtrl+Shift+T")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("file.close", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&open)
        .item(&open_recent)
        .separator()
        .item(&save)
        .item(&save_as)
        .item(&save_options)
        .separator()
        .item(&reopen_closed)
        .item(&close_tab)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit UniNotepad"))?)
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
    // Accelerator is "=" (not "Plus") so it fires on Cmd/Ctrl+= without Shift,
    // matching what users actually press. The Shift variant (Cmd/Ctrl and "+")
    // is handled by a keydown listener in the webview.
    let zoom_in = MenuItemBuilder::with_id("view.zoomIn", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("view.zoomOut", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("view.zoomReset", "Reset Zoom")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let goto_line = MenuItemBuilder::with_id("view.gotoLine", "Go to Line…")
        .accelerator("CmdOrCtrl+G")
        .build(app)?;
    let toggle_wrap = MenuItemBuilder::with_id("view.toggleWrap", "Toggle Word Wrap")
        .accelerator("Alt+Z")
        .build(app)?;
    let toggle_preview =
        MenuItemBuilder::with_id("view.togglePreview", "Toggle Markdown Preview")
            .accelerator("CmdOrCtrl+Shift+M")
            .build(app)?;

    let goto_tabs = (1..=9)
        .map(|n| {
            let label = if n == 9 {
                "Go to Last Tab".to_string()
            } else {
                format!("Go to Tab {n}")
            };
            MenuItemBuilder::with_id(format!("view.gotoTab{n}"), label)
                .accelerator(format!("CmdOrCtrl+{n}"))
                .build(app)
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    // Theme — manual light/dark selection; "System" follows the OS.
    let theme_light = MenuItemBuilder::with_id("view.themeLight", "Light").build(app)?;
    let theme_dark = MenuItemBuilder::with_id("view.themeDark", "Dark").build(app)?;
    let theme_system = MenuItemBuilder::with_id("view.themeSystem", "System").build(app)?;
    let theme_menu = SubmenuBuilder::new(app, "Theme")
        .item(&theme_light)
        .item(&theme_dark)
        .item(&theme_system)
        .build()?;

    let mut view_builder = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&goto_line)
        .item(&toggle_wrap)
        .item(&toggle_preview)
        .separator();
    for item in &goto_tabs {
        view_builder = view_builder.item(item);
    }
    view_builder = view_builder.separator().item(&theme_menu);
    let view_menu = view_builder.build()?;

    Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu])
}
