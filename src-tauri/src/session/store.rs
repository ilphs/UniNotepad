//! On-disk session store: paths, atomic writes, and fsync discipline.
//!
//! Durability model: every file (manifest and each backup) is written to a temp
//! file in the same directory, fsync'd, then atomically renamed over the target
//! via `crate::fsio::atomic_write_bytes`. A `kill -9` or power loss therefore
//! leaves each file as either the complete old version or the complete new
//! version — never a torn write.

use std::path::PathBuf;

use crate::fsio::atomic_write_bytes;

use super::model::SessionManifest;

/// Resolved locations inside the app data directory.
pub struct SessionPaths {
    #[allow(dead_code)]
    pub root: PathBuf,
    pub manifest: PathBuf,
    pub backups_dir: PathBuf,
}

impl SessionPaths {
    pub fn new(app_data_dir: PathBuf) -> SessionPaths {
        let manifest = app_data_dir.join("session.json");
        let backups_dir = app_data_dir.join("backups");
        SessionPaths {
            root: app_data_dir,
            manifest,
            backups_dir,
        }
    }

    pub fn backup_file(&self, tab_id: &str) -> PathBuf {
        // tab ids are UUIDs — safe as filenames; still guard against separators.
        let safe: String = tab_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        self.backups_dir.join(format!("{safe}.txt"))
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.backups_dir)
    }
}

pub fn write_manifest(paths: &SessionPaths, manifest_json: &str) -> std::io::Result<()> {
    paths.ensure_dirs()?;
    atomic_write_bytes(&paths.manifest, manifest_json.as_bytes())
}

pub fn write_backup(paths: &SessionPaths, tab_id: &str, content: &str) -> std::io::Result<()> {
    paths.ensure_dirs()?;
    atomic_write_bytes(&paths.backup_file(tab_id), content.as_bytes())
}

pub fn delete_backup(paths: &SessionPaths, tab_id: &str) -> std::io::Result<()> {
    let f = paths.backup_file(tab_id);
    match std::fs::remove_file(&f) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

pub fn read_backup(paths: &SessionPaths, tab_id: &str) -> Option<String> {
    std::fs::read_to_string(paths.backup_file(tab_id)).ok()
}

/// Read + parse the manifest. On a corrupt manifest, rename it aside for
/// forensics and return None so the caller starts a fresh session.
pub fn read_manifest(paths: &SessionPaths) -> Option<SessionManifest> {
    let raw = std::fs::read_to_string(&paths.manifest).ok()?;
    match serde_json::from_str::<SessionManifest>(&raw) {
        Ok(m) => Some(m),
        Err(_) => {
            let corrupt = paths.manifest.with_extension("json.corrupt");
            let _ = std::fs::rename(&paths.manifest, corrupt);
            None
        }
    }
}

/// Delete any backup file whose tab id is not referenced by the manifest.
pub fn gc_orphan_backups(paths: &SessionPaths, live_ids: &[String]) {
    let Ok(entries) = std::fs::read_dir(&paths.backups_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !live_ids.iter().any(|id| id == stem) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_paths() -> SessionPaths {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("uninotepad-test-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        SessionPaths::new(dir)
    }

    #[test]
    fn backup_write_read_delete_roundtrip() {
        let p = temp_paths();
        write_backup(&p, "abc-123", "content\nhere").unwrap();
        assert_eq!(read_backup(&p, "abc-123").as_deref(), Some("content\nhere"));
        delete_backup(&p, "abc-123").unwrap();
        assert_eq!(read_backup(&p, "abc-123"), None);
        // deleting a missing backup is a no-op, not an error
        delete_backup(&p, "abc-123").unwrap();
        let _ = std::fs::remove_dir_all(&p.root);
    }

    #[test]
    fn manifest_overwrite_is_atomic_and_reads_back() {
        let p = temp_paths();
        write_manifest(&p, r#"{"version":1,"activeTabId":null,"nextUntitled":1,"tabs":[]}"#).unwrap();
        let m = read_manifest(&p).expect("manifest should parse");
        assert_eq!(m.version, 1);
        assert!(m.tabs.is_empty());
        let _ = std::fs::remove_dir_all(&p.root);
    }

    #[test]
    fn corrupt_manifest_is_quarantined_and_returns_none() {
        let p = temp_paths();
        p.ensure_dirs().unwrap();
        std::fs::write(&p.manifest, "{ this is not json").unwrap();
        assert!(read_manifest(&p).is_none());
        // original moved aside, not left in place
        assert!(!p.manifest.exists());
        assert!(p.manifest.with_extension("json.corrupt").exists());
        let _ = std::fs::remove_dir_all(&p.root);
    }

    #[test]
    fn gc_removes_only_unreferenced_backups() {
        let p = temp_paths();
        write_backup(&p, "keep", "x").unwrap();
        write_backup(&p, "drop", "y").unwrap();
        gc_orphan_backups(&p, &["keep".to_string()]);
        assert_eq!(read_backup(&p, "keep").as_deref(), Some("x"));
        assert_eq!(read_backup(&p, "drop"), None);
        let _ = std::fs::remove_dir_all(&p.root);
    }
}
