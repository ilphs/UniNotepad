//! Session persistence commands: load, persist (backups + manifest), delete.
//!
//! Every window runs its own frontend and flushes on its own schedule, but they
//! all share one `session.json`. Rust therefore keeps the merged manifest in
//! memory (`SessionState`) and each call swaps only the caller's slice, keyed
//! by its window label, before rewriting the whole file. If windows wrote the
//! file directly, the last flush would silently drop every other window's tabs.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State};

use crate::session::model::{SessionManifest, WindowSession};
use crate::session::store::{self, SessionPaths};

/// The lock is held for the whole of each persist (backups + manifest write)
/// so two windows' flushes cannot interleave, and so GC never runs between a
/// backup write and the manifest write that references it.
#[derive(Default)]
pub struct SessionState(Mutex<SessionInner>);

#[derive(Default)]
struct SessionInner {
    /// Merged manifest of every window, filled from disk on first use. `None`
    /// means "not loaded yet", which is different from an empty session: the
    /// first fill is also when orphan-backup GC runs (see `cached`).
    manifest: Option<SessionManifest>,
    /// Windows closed on purpose (`forget_window`). A flush from such a window
    /// that was already queued — or a timer firing in the moment between
    /// forget and destroy — must not put the discarded slice back. Cleared
    /// when a new window takes the label (`unforget`).
    forgotten: HashSet<String>,
}

#[derive(Serialize)]
pub struct LoadedSession {
    /// The calling window's slice only; other windows load their own.
    pub session: WindowSession,
    /// tab id -> backup content, pre-read to avoid N round trips on startup.
    pub backups: HashMap<String, String>,
}

fn resolve_paths(app: &tauri::AppHandle) -> Result<SessionPaths, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(SessionPaths::new(dir))
}

/// The merged manifest, reading it from disk the first time.
///
/// GC runs once here, at first fill, against the tab ids of *all* windows —
/// never per window, because when a later window loads, the other windows may
/// hold backups written since startup that are only in memory so far. A
/// missing or quarantined manifest skips GC, as before multi-window.
fn cached<'a>(inner: &'a mut SessionInner, paths: &SessionPaths) -> &'a mut SessionManifest {
    inner.manifest.get_or_insert_with(|| match store::read_manifest(paths) {
        Some(manifest) => {
            store::gc_orphan_backups(paths, &manifest.tab_ids());
            manifest
        }
        None => SessionManifest::empty(),
    })
}

#[tauri::command]
pub fn load_session(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<SessionState>,
) -> Result<Option<LoadedSession>, String> {
    let paths = resolve_paths(&app)?;
    // Recover from a poisoned lock instead of panicking, as elsewhere.
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let manifest = cached(&mut inner, &paths);

    let Some(session) = manifest.window(window.label()) else {
        return Ok(None);
    };

    // Pre-read backups for tabs that declare one.
    let mut backups = HashMap::new();
    for tab in &session.tabs {
        if tab.has_backup {
            if let Some(content) = store::read_backup(&paths, &tab.id) {
                backups.insert(tab.id.clone(), content);
            }
        }
    }

    Ok(Some(LoadedSession {
        session: session.clone(),
        backups,
    }))
}

/// One consistent flush of the calling window: write its dirty backups first,
/// then the merged manifest. If the process dies between them the manifest
/// points at slightly older backup content — consistent, never corrupt.
#[tauri::command]
pub fn persist_session(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<SessionState>,
    session_json: String,
    dirty_backups: Vec<(String, String)>,
) -> Result<(), String> {
    let mut session: WindowSession =
        serde_json::from_str(&session_json).map_err(|e| format!("session: {e}"))?;
    // The slot is decided by who is calling, not by the payload.
    session.label = window.label().to_string();

    let paths = resolve_paths(&app)?;
    paths.ensure_dirs().map_err(|e| format!("ensure_dirs: {e}"))?;

    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if inner.forgotten.contains(&session.label) {
        return Ok(()); // closed and discarded; see `SessionInner::forgotten`
    }
    let manifest = cached(&mut inner, &paths);

    for (tab_id, content) in &dirty_backups {
        store::write_backup(&paths, tab_id, content)
            .map_err(|e| format!("backup {tab_id}: {e}"))?;
    }

    // Updated in memory even if the write below fails: the next flush of any
    // window rewrites the whole file, so the slice is not lost, only delayed.
    manifest.upsert_window(session);
    store::write_manifest(&paths, manifest).map_err(|e| format!("manifest: {e}"))?;
    Ok(())
}

/// Drop the calling window's slice for good: it is closing while other
/// windows stay open, and the user has agreed to discard its tabs (the last
/// window never calls this — its slice is what the next launch restores).
///
/// Manifest first, backups second: dying in between leaves orphan backups,
/// which the next launch's GC removes. The reverse order could leave the
/// manifest pointing at deleted backups.
#[tauri::command]
pub fn forget_window(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<SessionState>,
) -> Result<(), String> {
    let paths = resolve_paths(&app)?;
    let label = window.label().to_string();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    inner.forgotten.insert(label.clone());
    let manifest = cached(&mut inner, &paths);
    let Some(slice) = manifest.remove_window(&label) else {
        return Ok(()); // never persisted (closed right after opening)
    };
    store::write_manifest(&paths, manifest).map_err(|e| format!("manifest: {e}"))?;
    for tab in &slice.tabs {
        let _ = store::delete_backup(&paths, &tab.id);
    }
    Ok(())
}

/// Labels of the secondary windows the previous session had, in order, for
/// `windows::restore_windows` to reopen at startup. Also where `main` adopts
/// a slice if it has none (`SessionManifest::ensure_main_window`) — this runs
/// before any frontend loads, so `main`'s own `load_session` already sees it.
pub(crate) fn windows_to_restore(app: &tauri::AppHandle) -> Vec<String> {
    let Ok(paths) = resolve_paths(app) else {
        return Vec::new();
    };
    let state = app.state::<SessionState>();
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let manifest = cached(&mut inner, &paths);
    manifest.ensure_main_window();
    manifest
        .windows
        .iter()
        .map(|w| w.label.clone())
        .filter(|l| l != crate::session::model::MAIN_WINDOW_LABEL)
        .collect()
}

/// Labels that own a slice right now — a new window must not pick one of
/// these, or it would load another window's tabs as its own.
pub(crate) fn session_labels(app: &tauri::AppHandle) -> Vec<String> {
    let state = app.state::<SessionState>();
    let inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    inner
        .manifest
        .as_ref()
        .map(|m| m.windows.iter().map(|w| w.label.clone()).collect())
        .unwrap_or_default()
}

/// A new window is taking `label`: let its flushes through again.
pub(crate) fn unforget(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<SessionState>();
    state.0.lock().unwrap_or_else(|e| e.into_inner()).forgotten.remove(label);
}

#[tauri::command]
pub fn delete_backup(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    let paths = resolve_paths(&app)?;
    store::delete_backup(&paths, &tab_id).map_err(|e| format!("delete {tab_id}: {e}"))
}
