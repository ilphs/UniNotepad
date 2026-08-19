mod commands;
mod encoding;
mod fsio;
mod menu;
mod session;
mod watcher;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Queue for "open these files" requests that may arrive (esp. on macOS via
/// `RunEvent::Opened`) before the WebView has finished loading. The frontend
/// calls `frontend_ready` once it is listening, which drains the queue.
#[derive(Default)]
struct PendingOpen(Mutex<PendingState>);

#[derive(Default)]
struct PendingState {
    ready: bool,
    queue: Vec<String>,
}

/// Turn argv (or a set of path strings) into existing absolute file paths,
/// resolving relative entries against `cwd`. Flags and non-files are dropped.
fn paths_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() {
                p
            } else {
                cwd.join(p)
            }
        })
        .filter(|p| p.is_file())
        .filter_map(|p| p.to_str().map(|s| s.to_string()))
        .collect()
}

/// Emit paths to the frontend, or queue them if it is not ready yet.
fn deliver_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<PendingOpen>();
    // Recover from a poisoned lock instead of panicking: under release
    // panic="abort" a poisoned mutex would otherwise take the whole app down.
    let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if s.ready {
        let _ = app.emit("open-paths", paths);
    } else {
        s.queue.extend(paths);
    }
}

/// Everything the native menu is built from that the *frontend* owns.
///
/// There is no cheap "flip one item" path here: changing the menu means
/// rebuilding it and swapping the whole thing in via `set_menu`. So if each
/// command only knew its own input, the rebuilds would clobber each other —
/// updating the recent-files list would reset the theme check marks, and
/// picking a theme would empty Open Recent. Keeping every input in one place
/// means any single-field update still produces a menu that reflects
/// everything the frontend has told us so far.
#[derive(Default)]
struct MenuState(Mutex<MenuInputs>);

struct MenuInputs {
    /// Recent files, newest first (File → Open Recent).
    recent: Vec<String>,
    /// Theme family id, e.g. "dracula" (View → Theme, upper group).
    family: String,
    /// Theme mode: "light" | "dark" | "system" (View → Theme, lower group).
    mode: String,
}

impl Default for MenuInputs {
    fn default() -> Self {
        Self {
            recent: Vec::new(),
            // Mirrors the frontend's own defaults, so the menu built during
            // setup already shows the right marks for a first run — before the
            // webview has read localStorage and synced back.
            family: "dracula".to_string(),
            mode: "dark".to_string(),
        }
    }
}

/// Rebuild the whole native menu from `MenuState` and swap it in.
///
/// The state is copied out and the lock dropped *before* building: menu
/// construction re-enters Tauri (and hops to the main thread on some
/// platforms), so holding the lock across it risks a deadlock the day any of
/// that path reads `MenuState` again.
fn rebuild_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let (recent, family, mode) = {
        let state = app.state::<MenuState>();
        // Recover from a poisoned lock rather than panicking, as elsewhere.
        let s = state.0.lock().unwrap_or_else(|e| e.into_inner());
        (s.recent.clone(), s.family.clone(), s.mode.clone())
    };
    let menu = menu::build(app, &recent, &family, &mode)?;
    app.set_menu(menu)?;
    Ok(())
}

/// Update the recent-files list and rebuild the menu. The JS-side recent list
/// lives in localStorage, so the frontend drives this after every change (and
/// once at startup). Best-effort on the JS side.
#[tauri::command]
fn set_recent_files(app: AppHandle, paths: Vec<String>) -> tauri::Result<()> {
    {
        let state = app.state::<MenuState>();
        let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
        s.recent = paths;
    }
    rebuild_menu(&app)
}

/// Update the theme check marks and rebuild the menu. The frontend owns the
/// theme (localStorage + `<html data-theme>`) and calls this after applying a
/// change from any entry point — menu, Preferences, or a restored session — so
/// the marks follow rather than lead. Best-effort on the JS side.
#[tauri::command]
fn set_theme_menu(app: AppHandle, family: String, mode: String) -> tauri::Result<()> {
    {
        let state = app.state::<MenuState>();
        let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
        s.family = family;
        s.mode = mode;
    }
    rebuild_menu(&app)
}

/// Whether this process is running from a Linux AppImage. Only AppImage bundles
/// support the updater's in-place `downloadAndInstall`; `.deb`/`.rpm` installs do
/// not, so the frontend uses this to decide between the in-app install button and
/// the "open download page" fallback. AppImage sets the `APPIMAGE` env var to the
/// mounted image path at launch, which is the canonical way to detect it. Always
/// false off Linux (macOS/Windows branch on `platform()` in the frontend instead).
#[tauri::command]
fn is_appimage() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some()
}

#[tauri::command]
fn frontend_ready(app: AppHandle, state: State<PendingOpen>) {
    let mut s = state.0.lock().unwrap_or_else(|e| e.into_inner());
    s.ready = true;
    if !s.queue.is_empty() {
        let paths = std::mem::take(&mut s.queue);
        drop(s);
        let _ = app.emit("open-paths", paths);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance MUST be registered first: a second launch forwards
        // its argv/cwd here instead of starting a new process.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let cwd = PathBuf::from(cwd);
            // argv[0] is the executable path — skip it.
            let args = argv.into_iter().skip(1);
            let paths = paths_from_args(args, &cwd);
            deliver_paths(app, paths);
            // Bring the existing window forward.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        // Opens the homepage link in the About dialog via the default browser.
        .plugin(tauri_plugin_opener::init())
        // In-app updates: `check()` (all platforms) + `downloadAndInstall`
        // (Windows/Linux-AppImage). `process` provides `relaunch()` after an
        // install. Order after single-instance is irrelevant for these.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PendingOpen::default())
        .manage(MenuState::default())
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            set_recent_files,
            set_theme_menu,
            is_appimage,
            commands::file::open_file,
            commands::file::open_file_as,
            commands::file::save_file,
            commands::file::stat_file,
            commands::session::load_session,
            commands::session::persist_session,
            commands::session::delete_backup,
            watcher::watch_file,
            watcher::unwatch_file,
        ])
        .setup(|app| {
            let handle = app.handle();
            // First build uses the `MenuInputs` defaults (empty recent list,
            // dracula/dark) — the frontend calls set_recent_files and
            // set_theme_menu once it has read localStorage, each of which
            // rebuilds through the same path.
            rebuild_menu(handle)?;

            // Route menu clicks to the frontend as a `menu` event.
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.clone());
            });

            // Files passed on the command line at first launch.
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let paths = paths_from_args(std::env::args().skip(1), &cwd);
            deliver_paths(handle, paths);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS/iOS deliver file-association opens as URLs, possibly before
            // the WebView is ready — hence the queue. This variant does not exist
            // on other platforms, so gate it out.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter_map(|p| p.to_str().map(|s| s.to_string()))
                    .collect();
                deliver_paths(_app, paths);
            }
        });
}
