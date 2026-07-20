//! File I/O commands: open, save, and stat with encoding + EOL handling.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::encoding::{self, Encoding, Eol};
use crate::fsio;

#[derive(Serialize)]
pub struct OpenedFile {
    /// Decoded content, normalized to LF.
    pub content: String,
    pub encoding: String,
    pub eol: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<u64>,
    /// True when some bytes could not be decoded and were replaced (U+FFFD).
    pub lossy: bool,
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

#[tauri::command]
pub fn open_file(path: String) -> Result<OpenedFile, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let decoded = encoding::decode(&bytes);
    Ok(OpenedFile {
        content: decoded.content,
        encoding: decoded.encoding.as_str().to_string(),
        eol: decoded.eol.as_str().to_string(),
        mtime_ms: mtime_ms(Path::new(&path)),
        lossy: decoded.lossy,
    })
}

/// Re-read a file forcing a specific encoding (skips detection). Backs the
/// status-bar "reinterpret with encoding" path so a mis-guessed file (e.g. a
/// Korean EUC-KR file that opened as Latin-1) can be re-decoded correctly.
#[tauri::command]
pub fn open_file_as(path: String, encoding: String) -> Result<OpenedFile, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let decoded = encoding::decode_as(&bytes, Encoding::from_str(&encoding));
    Ok(OpenedFile {
        content: decoded.content,
        encoding: decoded.encoding.as_str().to_string(),
        eol: decoded.eol.as_str().to_string(),
        mtime_ms: mtime_ms(Path::new(&path)),
        lossy: decoded.lossy,
    })
}

#[tauri::command]
pub fn save_file(
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
    Ok(SavedFile {
        mtime_ms: mtime_ms(Path::new(&path)),
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
