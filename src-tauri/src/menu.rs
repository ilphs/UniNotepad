//! Native application menu. Clicks on custom items emit a `menu` event to the
//! webview carrying the item id (e.g. "file.save"); the frontend maps ids to
//! actions. Editing/clipboard items use Tauri predefined items so the OS drives
//! them against the focused WebView natively.
//!
//! ## Assembly order matters on Windows
//!
//! Every submenu is attached to the root `Menu` *before* its items are appended,
//! and nested submenus follow the same rule. This is not stylistic: on Windows,
//! muda registers an item's accelerator into the accelerator table owned by the
//! root menu at the moment the item is appended, and it does not walk back into
//! submenus that were already populated. Building bottom-up (items → submenu →
//! root) therefore leaves the root's `HACCEL` table empty, and Tauri's Win32
//! `TranslateAcceleratorW` hook silently matches nothing — the menu renders with
//! its "Ctrl+S" hints and mouse clicks still work, but no shortcut ever fires.
//! macOS and GTK are unaffected because they store accelerators per item at
//! creation time, so the bug is invisible outside Windows.
//!
//! Even with a populated table, `TranslateAcceleratorW` only sees keys that
//! reach the host thread's message loop — and WebView2 pumps keyboard input in
//! its own child HWND, so while the webview has focus (practically always)
//! accelerators still never fire on Windows. The webview-side fallback in
//! `src/main.ts` replays this table as `handleMenu(id)` calls for that case;
//! the accelerators declared here remain the source of truth for the menu's
//! hint text, and the two never double-fire because they are separated by
//! focus. Keep the fallback table in sync when touching accelerators here.

use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Label for one "Open Recent" entry: the file's basename plus a dir hint so
/// two files with the same name are still tellable apart.
fn recent_label(path: &str) -> String {
    let p = std::path::Path::new(path);
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path);
    match p.parent().and_then(|d| d.to_str()).filter(|d| !d.is_empty()) {
        Some(dir) => format!("{name}  —  {dir}"),
        None => name.to_string(),
    }
}

/// Build the native menu. `recent` is the recent-files list (newest first) used
/// to populate the File → Open Recent submenu; pass an empty slice for the
/// initial build (the frontend re-invokes `set_recent_files` once it has read
/// localStorage, which rebuilds the whole menu with a populated list).
pub fn build<R: Runtime>(app: &AppHandle<R>, recent: &[String]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    // macOS convention: a leading application menu named after the app, carrying
    // About / Hide / Quit. The OS treats the first submenu as the app menu, so
    // this must come before File.
    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::new(app, "UniNotepad", true)?;
        menu.append(&app_menu)?;
        // A custom item rather than `PredefinedMenuItem::about`: predefined items
        // emit no `menu` event, so the frontend could not show its own dialog.
        // Non-macOS gets the same id under a Help submenu at the bottom.
        let about = MenuItemBuilder::with_id("help.about", "About UniNotepad").build(app)?;
        // Manual update check — no accelerator, so main.ts's accelTable is
        // untouched. Sits under About, the platform-standard place for it.
        let check_updates =
            MenuItemBuilder::with_id("help.checkUpdates", "Check for Updates…").build(app)?;
        // Platform-standard Settings item under the app menu (Cmd+,). On other
        // OSes this lives in the File menu as "Preferences…" (Ctrl+,) instead.
        let settings = MenuItemBuilder::with_id("app.preferences", "Settings…")
            .accelerator("Cmd+,")
            .build(app)?;
        app_menu.append_items(&[
            &about,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit UniNotepad"))?,
        ])?;
    }

    // File
    let file_menu = Submenu::new(app, "File", true)?;
    menu.append(&file_menu)?;

    let new_tab = MenuItemBuilder::with_id("file.new", "New Tab")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let open = MenuItemBuilder::with_id("file.open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    // "Open Recent" is a submenu rebuilt from `recent`. It is attached to the
    // File menu (below) *before* its items are appended, per the Windows HACCEL
    // ordering rule in this module's header — even though its entries carry no
    // accelerators, the pattern is kept uniform.
    let open_recent = Submenu::new(app, "Open Recent", true)?;
    let save = MenuItemBuilder::with_id("file.save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("file.saveAs", "Save As…")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let save_all = MenuItemBuilder::with_id("file.saveAll", "Save All")
        .accelerator("CmdOrCtrl+Alt+S")
        .build(app)?;
    // Non-macOS Preferences lives in the File menu with Ctrl+,. On macOS the
    // equivalent "Settings…" (Cmd+,) sits in the app menu instead, so it is
    // omitted here to avoid a duplicate.
    #[cfg(not(target_os = "macos"))]
    let preferences = MenuItemBuilder::with_id("app.preferences", "Preferences…")
        .accelerator("Ctrl+,")
        .build(app)?;
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
    // Bulk close entries — no accelerators (they mirror the tab context menu).
    let close_others =
        MenuItemBuilder::with_id("file.closeOthers", "Close Other Tabs").build(app)?;
    let close_right =
        MenuItemBuilder::with_id("file.closeRight", "Close Tabs to the Right").build(app)?;
    let close_all = MenuItemBuilder::with_id("file.closeAll", "Close All Tabs").build(app)?;

    file_menu.append_items(&[
        &new_tab,
        &open,
        &open_recent,
        &PredefinedMenuItem::separator(app)?,
        &save,
        &save_as,
        &save_all,
    ])?;
    // Preferences sits between Save All and the export group on non-macOS.
    #[cfg(not(target_os = "macos"))]
    file_menu.append_items(&[&preferences])?;
    file_menu.append_items(&[
        &PredefinedMenuItem::separator(app)?,
        &export_html,
        &print_preview,
        &PredefinedMenuItem::separator(app)?,
        &reopen_closed,
        &close_tab,
        &close_others,
        &close_right,
        &close_all,
    ])?;

    // Populate the Open Recent submenu now that it is attached to File. A
    // "Show All…" entry (keeping the old file.openRecent id) opens the in-app
    // picker as a fallback; then the recent paths, or a disabled placeholder.
    let show_all = MenuItemBuilder::with_id("file.openRecent", "Show All…").build(app)?;
    open_recent.append(&show_all)?;
    open_recent.append(&PredefinedMenuItem::separator(app)?)?;
    if recent.is_empty() {
        let none = MenuItemBuilder::with_id("file.recentNone", "No Recent Files")
            .enabled(false)
            .build(app)?;
        open_recent.append(&none)?;
    } else {
        for path in recent {
            // The MenuId carries the full path so the click handler can reopen
            // it directly (muda accepts an arbitrary String id).
            let item =
                MenuItemBuilder::with_id(format!("file.recent:{path}"), recent_label(path))
                    .build(app)?;
            open_recent.append(&item)?;
        }
        open_recent.append(&PredefinedMenuItem::separator(app)?)?;
        let clear = MenuItemBuilder::with_id("file.clearRecent", "Clear Recent").build(app)?;
        open_recent.append(&clear)?;
    }
    // Quit lives in the macOS application menu (the first submenu); on the other
    // platforms it stays at the bottom of File.
    #[cfg(not(target_os = "macos"))]
    file_menu.append_items(&[
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, Some("Quit UniNotepad"))?,
    ])?;

    // Edit — undo/redo are custom (must drive CodeMirror history), the rest are
    // predefined so native clipboard handling applies to the WebView.
    let edit_menu = Submenu::new(app, "Edit", true)?;
    menu.append(&edit_menu)?;

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
    // macOS: Cmd+H now belongs to the app menu's Hide item, so Replace takes
    // the platform-standard Option+Cmd+F instead (CM6 leaves Mod-Alt-f unbound).
    let replace = MenuItemBuilder::with_id("edit.replace", "Replace…")
        .accelerator(if cfg!(target_os = "macos") {
            "Cmd+Alt+F"
        } else {
            "Ctrl+H"
        })
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

    edit_menu.append_items(&[
        &undo,
        &redo,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, Some("Cut"))?,
        &PredefinedMenuItem::copy(app, Some("Copy"))?,
        &PredefinedMenuItem::paste(app, Some("Paste"))?,
        &PredefinedMenuItem::select_all(app, Some("Select All"))?,
        &PredefinedMenuItem::separator(app)?,
        &find,
        &find_next,
        &find_prev,
        &replace,
        &select_next_occurrence,
        &PredefinedMenuItem::separator(app)?,
    ])?;

    // Line Operations — a Notepad++-style submenu. All act on the selected lines,
    // or the whole document when there is no selection.
    let line_ops = Submenu::new(app, "Line Operations", true)?;
    edit_menu.append(&line_ops)?;

    let sort_asc = MenuItemBuilder::with_id("edit.sortAsc", "Sort Lines Ascending").build(app)?;
    let sort_desc = MenuItemBuilder::with_id("edit.sortDesc", "Sort Lines Descending").build(app)?;
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

    line_ops.append_items(&[
        &sort_asc,
        &sort_desc,
        &PredefinedMenuItem::separator(app)?,
        &dedupe,
        &remove_empty,
        &trim_trailing,
        &PredefinedMenuItem::separator(app)?,
        &to_upper,
        &to_lower,
        &PredefinedMenuItem::separator(app)?,
        &move_up,
        &move_down,
    ])?;

    // View
    let view_menu = Submenu::new(app, "View", true)?;
    menu.append(&view_menu)?;

    // Zoom accelerator is "=" (not "Plus") so it fires on Cmd/Ctrl+= without
    // Shift, matching what users actually press. The Shift variant (Cmd/Ctrl and
    // "+") is handled by a keydown listener in the webview.
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
    // Alt+Z toggles word wrap. On macOS the accelerator is dropped: Option+Z
    // emits "Ω", so the native match fails — the webview handles it via e.code
    // instead (main.ts), and the key is spelled out in the label.
    #[cfg(not(target_os = "macos"))]
    let toggle_wrap = MenuItemBuilder::with_id("view.toggleWrap", "Toggle Word Wrap")
        .accelerator("Alt+Z")
        .build(app)?;
    #[cfg(target_os = "macos")]
    let toggle_wrap =
        MenuItemBuilder::with_id("view.toggleWrap", "Toggle Word Wrap (⌥Z)").build(app)?;
    // No accelerator — a discoverable toggle for rendering spaces/tabs and
    // marking trailing whitespace; the state persists in localStorage.
    let toggle_whitespace =
        MenuItemBuilder::with_id("view.toggleWhitespace", "Show Whitespace Characters").build(app)?;
    // No accelerator — a discoverable toggle for the line-number gutter; the
    // state persists in localStorage.
    let toggle_line_numbers =
        MenuItemBuilder::with_id("view.toggleLineNumbers", "Show Line Numbers").build(app)?;
    // Fold/Unfold All — the fold gutter and foldKeymap (Ctrl+Shift+[ / ]) drive
    // per-range folding; these operate on the whole document. No accelerator.
    let fold_all = MenuItemBuilder::with_id("view.foldAll", "Fold All").build(app)?;
    let unfold_all = MenuItemBuilder::with_id("view.unfoldAll", "Unfold All").build(app)?;
    let toggle_preview = MenuItemBuilder::with_id("view.togglePreview", "Toggle Preview")
        .accelerator("CmdOrCtrl+Shift+M")
        .build(app)?;

    view_menu.append_items(&[
        &zoom_in,
        &zoom_out,
        &zoom_reset,
        &PredefinedMenuItem::separator(app)?,
        &goto_line,
        &toggle_wrap,
        &toggle_whitespace,
        &toggle_line_numbers,
        &fold_all,
        &unfold_all,
        &toggle_preview,
    ])?;

    // Convert Line Endings — a discoverable menu entry for what the status-bar
    // EOL picker already does; converts the active tab's line endings.
    let eol_menu = Submenu::new(app, "Convert Line Endings", true)?;
    view_menu.append(&eol_menu)?;
    let eol_lf = MenuItemBuilder::with_id("view.eolLf", "LF (Unix)").build(app)?;
    let eol_crlf = MenuItemBuilder::with_id("view.eolCrlf", "CRLF (Windows)").build(app)?;
    eol_menu.append_items(&[&eol_lf, &eol_crlf])?;

    view_menu.append(&PredefinedMenuItem::separator(app)?)?;

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
    for item in &goto_tabs {
        view_menu.append(item)?;
    }

    // No accelerators: Ctrl+Tab / Ctrl+Shift+Tab are handled by a capture-phase
    // keydown listener in the webview (main.ts). The keys are spelled out in the
    // labels for discoverability, following the select_next_label precedent.
    let next_tab = MenuItemBuilder::with_id("view.nextTab", "Next Tab (Ctrl+Tab)").build(app)?;
    let prev_tab =
        MenuItemBuilder::with_id("view.prevTab", "Previous Tab (Ctrl+Shift+Tab)").build(app)?;
    view_menu.append_items(&[&next_tab, &prev_tab, &PredefinedMenuItem::separator(app)?])?;

    // Theme — manual light/dark selection; "System" follows the OS.
    let theme_menu = Submenu::new(app, "Theme", true)?;
    view_menu.append(&theme_menu)?;
    let theme_light = MenuItemBuilder::with_id("view.themeLight", "Light").build(app)?;
    let theme_dark = MenuItemBuilder::with_id("view.themeDark", "Dark").build(app)?;
    let theme_system = MenuItemBuilder::with_id("view.themeSystem", "System").build(app)?;
    theme_menu.append_items(&[&theme_light, &theme_dark, &theme_system])?;

    // Help — macOS already carries About in its application menu.
    #[cfg(not(target_os = "macos"))]
    {
        let help_menu = Submenu::new(app, "Help", true)?;
        menu.append(&help_menu)?;
        let about = MenuItemBuilder::with_id("help.about", "About UniNotepad").build(app)?;
        let check_updates =
            MenuItemBuilder::with_id("help.checkUpdates", "Check for Updates…").build(app)?;
        help_menu.append_items(&[&check_updates, &PredefinedMenuItem::separator(app)?, &about])?;
    }

    Ok(menu)
}
