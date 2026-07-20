mod commands;
mod encoding;
mod fsio;
mod menu;
mod session;

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
        .manage(PendingOpen::default())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            commands::file::open_file,
            commands::file::open_file_as,
            commands::file::save_file,
            commands::file::stat_file,
            commands::session::load_session,
            commands::session::persist_session,
            commands::session::delete_backup,
        ])
        .setup(|app| {
            let handle = app.handle();
            let menu = menu::build(handle)?;
            app.set_menu(menu)?;

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
