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
    let export_html =
        MenuItemBuilder::with_id("file.exportHtml", "Export Preview as HTML…").build(app)?;
    let print_preview = MenuItemBuilder::with_id("file.print", "Print Preview…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
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
        .item(&export_html)
        .item(&print_preview)
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

    // macOS: Cmd+G/Cmd+Shift+G, matching the platform convention and what
    // CodeMirror's searchKeymap already binds. Elsewhere Ctrl+G is Go to Line,
    // so F3 is the only convention-safe choice for Find Next.
    #[cfg(target_os = "macos")]
    let (next_accel, prev_accel) = ("Cmd+G", "Cmd+Shift+G");
    #[cfg(not(target_os = "macos"))]
    let (next_accel, prev_accel) = ("F3", "Shift+F3");

    let find_next = MenuItemBuilder::with_id("edit.findNext", "Find Next")
        .accelerator(next_accel)
        .build(app)?;
    let find_prev = MenuItemBuilder::with_id("edit.findPrev", "Find Previous")
        .accelerator(prev_accel)
        .build(app)?;
    let replace = MenuItemBuilder::with_id("edit.replace", "Replace…")
        .accelerator("CmdOrCtrl+H")
        .build(app)?;

    // No menu accelerator: CodeMirror's searchKeymap already binds Mod-d to
    // selectNextOccurrence, and on macOS the WebView's preventDefault beats a
    // native menu accelerator. The key is spelled out in the label instead.
    #[cfg(target_os = "macos")]
    let select_next_label = "Select Next Occurrence (Cmd+D)";
    #[cfg(not(target_os = "macos"))]
    let select_next_label = "Select Next Occurrence (Ctrl+D)";
    let select_next_occurrence =
        MenuItemBuilder::with_id("edit.selectNextOccurrence", select_next_label).build(app)?;

    // Line Operations — a Notepad++-style submenu. All act on the selected lines,
    // or the whole document when there is no selection.
    let sort_asc =
        MenuItemBuilder::with_id("edit.sortAsc", "Sort Lines Ascending").build(app)?;
    let sort_desc =
        MenuItemBuilder::with_id("edit.sortDesc", "Sort Lines Descending").build(app)?;
    let dedupe =
        MenuItemBuilder::with_id("edit.removeDuplicate", "Remove Duplicate Lines").build(app)?;
    let remove_empty =
        MenuItemBuilder::with_id("edit.removeEmpty", "Remove Empty Lines").build(app)?;
    let trim_trailing =
        MenuItemBuilder::with_id("edit.trimTrailing", "Trim Trailing Whitespace").build(app)?;
    let to_upper = MenuItemBuilder::with_id("edit.toUpper", "UPPERCASE").build(app)?;
    let to_lower = MenuItemBuilder::with_id("edit.toLower", "lowercase").build(app)?;
    // No menu accelerator: CodeMirror's defaultKeymap already binds Alt+Arrow to
    // move-line (and Shift+Alt+Arrow to copy-line), and on macOS the WebView's
    // preventDefault beats a native menu accelerator — a duplicate here would
    // collide with copy-line. The menu item stays for discoverability.
    let move_up = MenuItemBuilder::with_id("edit.moveLineUp", "Move Line Up (Alt+↑)").build(app)?;
    let move_down =
        MenuItemBuilder::with_id("edit.moveLineDown", "Move Line Down (Alt+↓)").build(app)?;
    let line_ops = SubmenuBuilder::new(app, "Line Operations")
        .item(&sort_asc)
        .item(&sort_desc)
        .separator()
        .item(&dedupe)
        .item(&remove_empty)
        .item(&trim_trailing)
        .separator()
        .item(&to_upper)
        .item(&to_lower)
        .separator()
        .item(&move_up)
        .item(&move_down)
        .build()?;

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
        .item(&find_next)
        .item(&find_prev)
        .item(&replace)
        .item(&select_next_occurrence)
        .separator()
        .item(&line_ops)
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

    // Ctrl+G on every platform (Control+G on macOS, as in VS Code): Cmd+G is
    // reserved for Find Next there. One string works everywhere because Tauri
    // maps "Ctrl" to Control on macOS, not Command.
    let goto_line = MenuItemBuilder::with_id("view.gotoLine", "Go to Line…")
        .accelerator("Ctrl+G")
        .build(app)?;
    let toggle_wrap = MenuItemBuilder::with_id("view.toggleWrap", "Toggle Word Wrap")
        .accelerator("Alt+Z")
        .build(app)?;
    // No accelerator — a discoverable toggle for rendering spaces/tabs and
    // marking trailing whitespace; the state persists in localStorage.
    let toggle_whitespace =
        MenuItemBuilder::with_id("view.toggleWhitespace", "Show Whitespace Characters").build(app)?;
    // Fold/Unfold All — the fold gutter and foldKeymap (Ctrl+Shift+[ / ]) drive
    // per-range folding; these operate on the whole document. No accelerator.
    let fold_all = MenuItemBuilder::with_id("view.foldAll", "Fold All").build(app)?;
    let unfold_all = MenuItemBuilder::with_id("view.unfoldAll", "Unfold All").build(app)?;
    let toggle_preview = MenuItemBuilder::with_id("view.togglePreview", "Toggle Preview")
        .accelerator("CmdOrCtrl+Shift+M")
        .build(app)?;

    // Convert Line Endings — a discoverable menu entry for what the status-bar
    // EOL picker already does; converts the active tab's line endings.
    let eol_lf = MenuItemBuilder::with_id("view.eolLf", "LF (Unix)").build(app)?;
    let eol_crlf = MenuItemBuilder::with_id("view.eolCrlf", "CRLF (Windows)").build(app)?;
    let eol_menu = SubmenuBuilder::new(app, "Convert Line Endings")
        .item(&eol_lf)
        .item(&eol_crlf)
        .build()?;

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
        .item(&toggle_whitespace)
        .item(&fold_all)
        .item(&unfold_all)
        .item(&toggle_preview)
        .item(&eol_menu)
        .separator();
    for item in &goto_tabs {
        view_builder = view_builder.item(item);
    }
    view_builder = view_builder.separator().item(&theme_menu);
    let view_menu = view_builder.build()?;

    Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu])
}
