//! Atomic filesystem writes shared by the session store and user-file saves.
//!
//! Durability model: bytes are written to a temp file in the same directory,
//! fsync'd, then atomically renamed over the target. `atomicwrites` gives us the
//! correct `rename` / `ReplaceFileW` behavior per OS, so a `kill -9` or power
//! loss leaves each file as either the complete old version or the complete new
//! version — never a torn write.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use atomicwrites::{AtomicFile, OverwriteBehavior};

/// Atomically write bytes to `target` (temp + fsync + rename).
pub(crate) fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let af = AtomicFile::new(target, OverwriteBehavior::AllowOverwrite);
    af.write(|f| f.write_all(bytes)).map_err(|e| match e {
        atomicwrites::Error::Internal(io) => io,
        atomicwrites::Error::User(io) => io,
    })
}

/// Resolve the real path to write when saving a user file.
///
/// If `path` is a symlink we must write to the link's *target*, never replace
/// the link itself with a regular file (an atomic rename would otherwise clobber
/// the link). A dangling link (target missing) is resolved one level against the
/// link's parent so the target file gets created where the link points.
fn resolve_save_target(path: &Path) -> io::Result<PathBuf> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => match std::fs::canonicalize(path) {
            Ok(real) => Ok(real),
            Err(_) => {
                // Dangling link: resolve read_link() one level against the parent.
                let link = std::fs::read_link(path)?;
                if link.is_absolute() {
                    Ok(link)
                } else {
                    let parent = path.parent().unwrap_or_else(|| Path::new("."));
                    Ok(parent.join(link))
                }
            }
        },
        _ => Ok(path.to_path_buf()),
    }
}

/// Atomically save a user document to `path`, preserving symlinks and
/// permissions.
///
/// - Symlinks: the link's final target is written, not the link itself.
/// - Existing file: its permissions are captured before the write and re-applied
///   afterwards (the atomic temp+rename otherwise resets them to the temp file's
///   restrictive default, e.g. 0600 on Unix).
/// - New file: pre-created empty so the OS applies the process default mode
///   (0666 minus umask on Unix) rather than the atomicwrites/tempfile 0600.
/// - Missing parent directory is created.
/// - No in-place fallback: if the directory is not writable the error propagates,
///   so atomicity is never silently traded away.
pub(crate) fn atomic_save_user_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let target = resolve_save_target(path)?;

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    // Capture the mode the saved file should end with, since the atomic
    // temp+rename would otherwise leave the tempfile's restrictive default.
    // A brand-new file is pre-created empty so the OS applies the process
    // default (umask-aware) instead of a hardcoded mode; worst case on a crash
    // right after is an empty file where none existed — never lost content.
    let perms = match std::fs::metadata(&target) {
        Ok(meta) => meta.permissions(),
        Err(_) => {
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .open(&target)?;
            std::fs::metadata(&target)?.permissions()
        }
    };

    atomic_write_bytes(&target, bytes)?;

    // The bytes are already durable; a failed mode restore is not worth
    // surfacing as a failed save.
    let _ = std::fs::set_permissions(&target, perms);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A fresh, empty temp directory unique to this test process + call.
    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("uninotepad-fsio-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn overwrite_roundtrip() {
        let dir = temp_dir();
        let file = dir.join("doc.txt");
        atomic_save_user_file(&file, b"first").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"first");
        atomic_save_user_file(&file, b"second longer content").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"second longer content");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let file = dir.join("secret.txt");
        std::fs::write(&file, b"old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        atomic_save_user_file(&file, b"new").unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read(&file).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn new_file_honors_process_umask() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        // A plain create in the same process shows what mode the umask allows.
        let control = dir.join("control.txt");
        std::fs::write(&control, b"x").unwrap();
        let expected = std::fs::metadata(&control).unwrap().permissions().mode() & 0o777;

        let file = dir.join("fresh.txt");
        atomic_save_user_file(&file, b"hi").unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, expected);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_is_written_link_preserved() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let target = dir.join("real.txt");
        let link = dir.join("link.txt");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        atomic_save_user_file(&link, b"updated via link").unwrap();

        // The link is still a symlink (not replaced by a regular file)...
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        // ...and its target now holds the new content with its mode preserved.
        assert_eq!(std::fs::read(&target).unwrap(), b"updated via link");
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_missing_parent_dir() {
        let dir = temp_dir();
        let file = dir.join("nested/deeper/doc.txt");
        atomic_save_user_file(&file, b"content").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"content");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
