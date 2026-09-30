//! Editor windows beyond the first: File → New Window, reopening the windows a
//! previous session had, and the bookkeeping that has to see every window at
//! once — deciding which close is the last one, and which window already holds
//! a given file.
//!
//! Every window runs the same frontend (`index.html`) with its own tabs; what
//! tells them apart is the label. `main` comes from `tauri.conf.json` and is
//! always opened by Tauri at launch; the others are `win-<n>`, a prefix the
//! capability file (`capabilities/default.json`) grants IPC to — a window
//! with any other label would load but every `invoke` would be refused.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands::session;

/// Label prefix of secondary windows. Must match the `win-*` capability glob.
pub const SECONDARY_PREFIX: &str = "win-";

/// Offset of a new window from the one it was opened from, so it does not sit
/// exactly on top of it (logical px, the usual cascade step).
const CASCADE_STEP: f64 = 28.0;

#[derive(Default)]
pub struct WindowRegistry(Mutex<RegistryInner>);

#[derive(Default)]
struct RegistryInner {
    /// Windows that have started closing (`begin_close_window`) and not been
    /// cancelled or destroyed yet. Used so two windows closing at once — e.g.
    /// macOS Option+click on the close button closes all of them — cannot
    /// both conclude "another window stays open" and both discard their tabs,
    /// leaving the app to exit with an empty session.
    closing: HashSet<String>,
    /// Files each window has open (label → paths), pushed by the frontend
    /// whenever its tab set changes. Lets `focus_path_owner` send a file that
    /// is already open elsewhere to that window instead of opening it twice.
    open_paths: HashMap<String, Vec<String>>,
}

/// Create an editor window. The size and minimum mirror the `main` window in
/// `tauri.conf.json` — keep them in sync. `tauri-plugin-window-state` then
/// restores the saved bounds for a label it has seen before, which is what
/// puts a reopened window back where it was.
fn build(app: &AppHandle, label: &str, cascade_from: Option<&WebviewWindow>) -> tauri::Result<()> {
    // Before building: the new window's first flush must not be dropped as
    // coming from a discarded window that had the same label.
    session::unforget(app, label);

    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("UniNotepad")
        .inner_size(1000.0, 700.0)
        .min_inner_size(480.0, 320.0);
    if let Some(src) = cascade_from {
        if let (Ok(pos), Ok(size), Ok(scale)) =
            (src.outer_position(), src.inner_size(), src.scale_factor())
        {
            let pos = pos.to_logical::<f64>(scale);
            let size = size.to_logical::<f64>(scale);
            builder = builder
                .position(pos.x + CASCADE_STEP, pos.y + CASCADE_STEP)
                .inner_size(size.width, size.height);
        }
    }
    builder.build()?;
    Ok(())
}

/// The lowest free `win-<n>`: not an open window, and not a label that still
/// owns a session slice (that slice would be loaded as the new window's tabs).
fn next_label(app: &AppHandle) -> String {
    let mut taken: HashSet<String> = app.webview_windows().into_keys().collect();
    taken.extend(session::session_labels(app));
    (1..)
        .map(|n| format!("{SECONDARY_PREFIX}{n}"))
        .find(|l| !taken.contains(l))
        .expect("an unbounded range always yields a free label")
}

/// File → New Window. `async` on purpose: building a window from a
/// synchronous command deadlocks on Windows (WebView2), per Tauri's docs.
#[tauri::command]
pub async fn new_window(app: AppHandle) -> Result<(), String> {
    let source = crate::target_window(&app);
    let label = next_label(&app);
    build(&app, &label, source.as_ref()).map_err(|e| e.to_string())
}

/// Reopen the secondary windows of the previous session, in their saved
/// order. Called from `setup`, before any frontend loads; `main` restores its
/// own slice as it always has.
pub fn restore_windows(app: &AppHandle) {
    for label in session::windows_to_restore(app) {
        // Only labels this module hands out get IPC (capability glob); a
        // foreign one (hand-edited file) would open a window that cannot load.
        if !label.starts_with(SECONDARY_PREFIX) {
            continue;
        }
        if let Err(e) = build(app, &label, None) {
            eprintln!("restore window {label}: {e}");
        }
    }
    // Secondary windows open on top of `main`; hand focus back to it so
    // launch looks the same as before multi-window.
    if let Some(main) = app.get_webview_window(crate::session::model::MAIN_WINDOW_LABEL) {
        let _ = main.set_focus();
    }
}

/// A window is about to close. Returns true when it is the last one — no
/// other window is open that is not itself closing — in which case its slice
/// stays in the session for the next launch; otherwise the frontend asks to
/// discard and calls `forget_window`. The caller is marked closing either way;
/// `cancel_close_window` undoes that if the user backs out.
#[tauri::command]
pub fn begin_close_window(window: tauri::Window, state: tauri::State<WindowRegistry>) -> bool {
    let label = window.label().to_string();
    let open: Vec<String> = window.app_handle().webview_windows().into_keys().collect();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let others_stay = open
        .iter()
        .any(|l| *l != label && !inner.closing.contains(l));
    inner.closing.insert(label);
    !others_stay
}

#[tauri::command]
pub fn cancel_close_window(window: tauri::Window, state: tauri::State<WindowRegistry>) {
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    inner.closing.remove(window.label());
}

#[tauri::command]
pub fn set_open_paths(
    window: tauri::Window,
    state: tauri::State<WindowRegistry>,
    paths: Vec<String>,
) {
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    inner.open_paths.insert(window.label().to_string(), paths);
}

/// If another window already has `path` open, activate that tab there, bring
/// the window forward and return true — the caller then skips opening it.
///
/// One file in one window keeps a single buffer per file. Two buffers of the
/// same file would each save over the other's edits, and the watcher's
/// self-save suppression (one entry per path, consumed by the first event)
/// would hide one window's save from the other.
#[tauri::command]
pub fn focus_path_owner(
    app: AppHandle,
    window: tauri::Window,
    state: tauri::State<WindowRegistry>,
    path: String,
) -> bool {
    let caller = window.label();
    let owner = {
        let inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .open_paths
            .iter()
            .find(|(label, paths)| {
                label.as_str() != caller && !inner.closing.contains(*label) && paths.contains(&path)
            })
            .map(|(label, _)| label.clone())
    };
    let Some(owner) = owner else {
        return false;
    };
    let Some(w) = app.get_webview_window(&owner) else {
        return false;
    };
    // The owner's `open-paths` handler finds the existing tab and activates it.
    // No readiness check needed: a window only reports paths once its
    // listeners are up (see `syncOpenPaths` in src/tabs.ts).
    crate::emit_to_window(&app, &owner, "open-paths", vec![path]);
    let _ = w.unminimize();
    let _ = w.set_focus();
    true
}

/// Forget a destroyed window's registry entries.
pub fn on_destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<WindowRegistry>();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    inner.closing.remove(label);
    inner.open_paths.remove(label);
}
