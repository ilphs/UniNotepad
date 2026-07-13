//! Session persistence commands: load, persist (backups + manifest), delete.

use std::collections::HashMap;

use serde::Serialize;
use tauri::Manager;

use crate::session::model::SessionManifest;
use crate::session::store::{self, SessionPaths};

#[derive(Serialize)]
pub struct LoadedSession {
    pub manifest: SessionManifest,
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

#[tauri::command]
pub fn load_session(app: tauri::AppHandle) -> Result<Option<LoadedSession>, String> {
    let paths = resolve_paths(&app)?;

    let Some(manifest) = store::read_manifest(&paths) else {
        return Ok(None);
    };

    // Pre-read backups for tabs that declare one.
    let mut backups = HashMap::new();
    for tab in &manifest.tabs {
        if tab.has_backup {
            if let Some(content) = store::read_backup(&paths, &tab.id) {
                backups.insert(tab.id.clone(), content);
            }
        }
    }

    // GC any backup file no longer referenced by the manifest.
    let live_ids: Vec<String> = manifest.tabs.iter().map(|t| t.id.clone()).collect();
    store::gc_orphan_backups(&paths, &live_ids);

    Ok(Some(LoadedSession { manifest, backups }))
}

/// One consistent flush: write every dirty backup first, then the manifest.
/// If the process dies between them the manifest points at slightly older
/// backup content — consistent, never corrupt.
#[tauri::command]
pub fn persist_session(
    app: tauri::AppHandle,
    manifest_json: String,
    dirty_backups: Vec<(String, String)>,
) -> Result<(), String> {
    let paths = resolve_paths(&app)?;
    paths.ensure_dirs().map_err(|e| format!("ensure_dirs: {e}"))?;

    for (tab_id, content) in &dirty_backups {
        store::write_backup(&paths, tab_id, content)
            .map_err(|e| format!("backup {tab_id}: {e}"))?;
    }

    store::write_manifest(&paths, &manifest_json).map_err(|e| format!("manifest: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_backup(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    let paths = resolve_paths(&app)?;
    store::delete_backup(&paths, &tab_id).map_err(|e| format!("delete {tab_id}: {e}"))
}
