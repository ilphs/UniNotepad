//! File I/O commands: open, save, and stat with encoding + EOL handling.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::encoding::{self, Encoding, Eol};
use crate::fsio;
use crate::watcher::{self, WatcherState};

/// Large-file guard thresholds. Past WARN a file loads only after the user
/// confirms and runs in a reduced mode (no syntax highlighting, no crash
/// backup); past HARD it is refused outright. Purely a performance guard, so
/// the check is best-effort (TOCTOU is intentionally ignored).
const LARGE_WARN_BYTES: u64 = 10 * 1024 * 1024;
const LARGE_HARD_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Serialize)]
pub struct OpenedFile {
    /// Decoded content, normalized to LF. Empty when `needs_large_confirm`.
    pub content: String,
    pub encoding: String,
    pub eol: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<u64>,
    /// True when some bytes could not be decoded and were replaced (U+FFFD).
    pub lossy: bool,
    /// File size in bytes, from the pre-read stat.
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    /// True when the file is over the warn threshold and the caller did not
    /// pass `allow_large`: nothing was read (`content` is empty) and the
    /// frontend must confirm before re-requesting with `allow_large`.
    #[serde(rename = "needsLargeConfirm")]
    pub needs_large_confirm: bool,
    /// True whenever the file is over the warn threshold — the frontend uses
    /// this to stay in reduced mode even after the user approves the open.
    pub large: bool,
}

#[derive(Serialize)]
pub struct SavedFile {
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<u64>,
    /// False when the save was skipped because it would be lossy and the caller
    /// did not pass `allow_lossy`.
    pub written: bool,
    /// True when the chosen encoding cannot represent every character.
    pub lossy: bool,
}

#[derive(Serialize)]
pub struct FileStat {
    pub exists: bool,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<u64>,
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as u64)
}

/// Outcome of the large-file pre-check shared by both open paths.
enum Guarded {
    /// Under the warn threshold, or the caller approved: here are the bytes.
    /// `large` stays true past the warn threshold so reduced mode sticks.
    Load { bytes: Vec<u8>, large: bool },
    /// Over the warn threshold and not yet approved: read nothing, let the
    /// frontend confirm and re-request with `allow_large`.
    NeedsConfirm { size: u64 },
}

/// Stat the file, enforce the hard limit, and decide whether to read. Errors
/// past the hard limit; signals `NeedsConfirm` past the warn limit unless the
/// caller passed `allow_large`; otherwise reads the bytes.
fn read_guarded(path: &str, allow_large: bool) -> Result<Guarded, String> {
    let size = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?.len();
    if size > LARGE_HARD_BYTES {
        return Err(format!(
            "{path}: file is {} MB, exceeding the {} MB limit",
            size / (1024 * 1024),
            LARGE_HARD_BYTES / (1024 * 1024)
        ));
    }
    let large = size > LARGE_WARN_BYTES;
    if large && !allow_large {
        return Ok(Guarded::NeedsConfirm { size });
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    Ok(Guarded::Load { bytes, large })
}

/// The "confirmation required" response: no content, just the size and flags so
/// the frontend can prompt (and, on approval, re-request with `allow_large`).
fn needs_large_confirm(size: u64) -> OpenedFile {
    OpenedFile {
        content: String::new(),
        encoding: Encoding::Utf8.as_str().to_string(),
        eol: Eol::Lf.as_str().to_string(),
        mtime_ms: None,
        lossy: false,
        size_bytes: size,
        needs_large_confirm: true,
        large: true,
    }
}

#[tauri::command]
pub fn open_file(path: String, allow_large: Option<bool>) -> Result<OpenedFile, String> {
    let (bytes, large) = match read_guarded(&path, allow_large.unwrap_or(false))? {
        Guarded::NeedsConfirm { size } => return Ok(needs_large_confirm(size)),
        Guarded::Load { bytes, large } => (bytes, large),
    };
    let size = bytes.len() as u64;
    let decoded = encoding::decode(&bytes);
    Ok(OpenedFile {
        content: decoded.content,
        encoding: decoded.encoding.as_str().to_string(),
        eol: decoded.eol.as_str().to_string(),
        mtime_ms: mtime_ms(Path::new(&path)),
        lossy: decoded.lossy,
        size_bytes: size,
        needs_large_confirm: false,
        large,
    })
}

/// Re-read a file forcing a specific encoding (skips detection). Backs the
/// status-bar "reinterpret with encoding" path so a mis-guessed file (e.g. a
/// Korean EUC-KR file that opened as Latin-1) can be re-decoded correctly.
#[tauri::command]
pub fn open_file_as(
    path: String,
    encoding: String,
    allow_large: Option<bool>,
) -> Result<OpenedFile, String> {
    let (bytes, large) = match read_guarded(&path, allow_large.unwrap_or(false))? {
        Guarded::NeedsConfirm { size } => return Ok(needs_large_confirm(size)),
        Guarded::Load { bytes, large } => (bytes, large),
    };
    let size = bytes.len() as u64;
    let decoded = encoding::decode_as(&bytes, Encoding::from_str(&encoding));
    Ok(OpenedFile {
        content: decoded.content,
        encoding: decoded.encoding.as_str().to_string(),
        eol: decoded.eol.as_str().to_string(),
        mtime_ms: mtime_ms(Path::new(&path)),
        lossy: decoded.lossy,
        size_bytes: size,
        needs_large_confirm: false,
        large,
    })
}

#[tauri::command]
pub fn save_file(
    state: State<WatcherState>,
    path: String,
    content: String,
    encoding: String,
    eol: String,
    allow_lossy: bool,
) -> Result<SavedFile, String> {
    let enc = Encoding::from_str(&encoding);
    let eol = Eol::from_str(&eol);
    let encoded = encoding::encode(&content, enc, eol);
    // Would-be-lossy save the caller hasn't approved: report it and write
    // nothing, letting the frontend prompt (Save as UTF-8 / Save Anyway).
    if encoded.lossy && !allow_lossy {
        return Ok(SavedFile {
            mtime_ms: None,
            written: false,
            lossy: true,
        });
    }
    fsio::atomic_save_user_file(Path::new(&path), &encoded.bytes)
        .map_err(|e| format!("{path}: {e}"))?;
    let mtime = mtime_ms(Path::new(&path));
    // Record our own write so the file watcher recognizes and suppresses the
    // resulting change event instead of reporting it as an external edit.
    if let Some(m) = mtime {
        watcher::record_self_save(state.inner(), &path, m);
    }
    Ok(SavedFile {
        mtime_ms: mtime,
        written: true,
        lossy: encoded.lossy,
    })
}

#[tauri::command]
pub fn stat_file(path: String) -> Result<FileStat, String> {
    let p = Path::new(&path);
    let exists = p.exists();
    Ok(FileStat {
        exists,
        mtime_ms: if exists { mtime_ms(p) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A fresh, empty temp directory unique to this test process + call.
    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("uninotepad-file-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Create a sparse file of exactly `len` bytes without writing them all —
    /// `set_len` grows the file, and the guard only stats its size.
    fn sparse_file(path: &Path, len: u64) {
        let f = File::create(path).unwrap();
        f.set_len(len).unwrap();
    }

    #[test]
    fn large_file_without_allow_asks_for_confirmation() {
        let dir = temp_dir();
        let file = dir.join("big.txt");
        sparse_file(&file, 11 * 1024 * 1024); // 11 MB, over the warn threshold
        let opened = open_file(file.to_string_lossy().into_owned(), None).unwrap();
        assert!(opened.needs_large_confirm);
        assert!(opened.large);
        assert!(opened.content.is_empty());
        assert_eq!(opened.size_bytes, 11 * 1024 * 1024);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn large_file_with_allow_loads_in_reduced_mode() {
        let dir = temp_dir();
        let file = dir.join("big.txt");
        sparse_file(&file, 11 * 1024 * 1024);
        let opened = open_file(file.to_string_lossy().into_owned(), Some(true)).unwrap();
        assert!(!opened.needs_large_confirm);
        assert!(opened.large);
        assert_eq!(opened.size_bytes, 11 * 1024 * 1024);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn over_hard_limit_is_refused() {
        let dir = temp_dir();
        let file = dir.join("huge.txt");
        sparse_file(&file, 101 * 1024 * 1024); // 101 MB, over the hard limit
        // OpenedFile is #[derive(Serialize)] only, so avoid unwrap_err (needs Debug).
        let err = match open_file(file.to_string_lossy().into_owned(), Some(true)) {
            Ok(_) => panic!("expected the hard limit to reject this file"),
            Err(e) => e,
        };
        assert!(err.contains("exceeding the 100 MB limit"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_file_clears_both_flags() {
        let dir = temp_dir();
        let file = dir.join("small.txt");
        std::fs::write(&file, b"hello\nworld\n").unwrap();
        let opened = open_file(file.to_string_lossy().into_owned(), None).unwrap();
        assert!(!opened.needs_large_confirm);
        assert!(!opened.large);
        assert_eq!(opened.content, "hello\nworld\n");
        assert_eq!(opened.size_bytes, 12);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
