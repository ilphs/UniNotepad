//! File I/O commands: open, save, and stat with encoding + EOL handling.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::encoding::{self, Encoding, Eol};

#[derive(Serialize)]
pub struct OpenedFile {
    /// Decoded content, normalized to LF.
    pub content: String,
    pub encoding: String,
    pub eol: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct SavedFile {
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<u64>,
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
    })
}

#[tauri::command]
pub fn save_file(
    path: String,
    content: String,
    encoding: String,
    eol: String,
) -> Result<SavedFile, String> {
    let enc = Encoding::from_str(&encoding);
    let eol = Eol::from_str(&eol);
    let bytes = encoding::encode(&content, enc, eol);
    std::fs::write(&path, &bytes).map_err(|e| format!("{path}: {e}"))?;
    Ok(SavedFile {
        mtime_ms: mtime_ms(Path::new(&path)),
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
