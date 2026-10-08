//! File I/O commands: open, save, and stat with encoding + EOL handling.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
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

#[derive(Serialize)]
pub struct ResolvedLink {
    /// Absolute path the link points at: canonicalized when the target exists,
    /// lexically normalized otherwise (a miss still has a path worth showing).
    pub path: String,
    pub exists: bool,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    /// True when the first bytes hold a NUL — the cheap heuristic git uses to
    /// tell text from binary. Only meaningful for a file that exists.
    pub binary: bool,
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

// ---- Document link resolution ----------------------------------------------

/// Bytes sniffed when deciding text vs. binary. One page is plenty: a binary
/// file that hides every NUL for 8 KB is rare enough to let through.
const SNIFF_BYTES: usize = 8192;

/// Resolve `.` and `..` without touching the disk, so a link to a file that
/// does not exist still yields a clean absolute path to report. A `..` that
/// would climb past the root is kept verbatim rather than silently dropped.
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                _ => out.push(comp.as_os_str()),
            },
            _ => out.push(comp.as_os_str()),
        }
    }
    out
}

/// Windows' `canonicalize` hands back an extended-length `\\?\C:\…` path, which
/// would then differ from the plain paths every tab carries (breaking the
/// already-open dedupe in openPath and reading badly in the title bar). Strip
/// the prefix. Harmless elsewhere: a canonicalized POSIX path starts with `/`.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let stripped = p.to_str().and_then(|s| {
        s.strip_prefix(r"\\?\UNC\")
            .map(|rest| PathBuf::from(format!(r"\\{rest}")))
            .or_else(|| s.strip_prefix(r"\\?\").map(PathBuf::from))
    });
    stripped.unwrap_or(p)
}

/// Whether the file's first page contains a NUL byte. Unreadable → false: the
/// open attempt that follows will surface the real error.
fn looks_binary(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; SNIFF_BYTES];
    match f.read(&mut buf) {
        Ok(n) => buf[..n].contains(&0),
        Err(_) => false,
    }
}

/// An href as a filesystem path: absolute as written, otherwise joined to the
/// directory of `base` (the linking document). Not normalized.
fn join_link(base: &str, href: &str) -> Result<PathBuf, String> {
    let href_path = Path::new(href);
    if href_path.is_absolute() {
        return Ok(href_path.to_path_buf());
    }
    let dir = Path::new(base)
        .parent()
        .ok_or_else(|| format!("{base}: no parent directory to resolve against"))?;
    Ok(dir.join(href_path))
}

/// Resolve a link target found inside a document against the document's own
/// path, and report enough for the frontend to decide what to do with it.
///
/// `base` is the linking file's path; `href` is the link's path part, with the
/// fragment stripped, any `file://` wrapper removed and percent-escapes decoded
/// by the caller (those are URL concerns, and the href comes from the DOM).
/// Nothing is opened here — this only stats and sniffs, leaving the open policy
/// to one place in the frontend.
#[tauri::command]
pub fn resolve_link(base: String, href: String) -> Result<ResolvedLink, String> {
    let normalized = lexical_normalize(&join_link(&base, &href)?);
    let meta = std::fs::metadata(&normalized).ok();
    let exists = meta.is_some();
    let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
    // canonicalize errors on a missing path, so it only runs when the target is
    // there; a failure (permissions, a broken symlink) keeps the lexical form.
    let path = if exists {
        strip_verbatim(std::fs::canonicalize(&normalized).unwrap_or(normalized))
    } else {
        normalized
    };
    Ok(ResolvedLink {
        binary: exists && !is_dir && looks_binary(&path),
        path: path.to_string_lossy().into_owned(),
        exists,
        is_dir,
    })
}

// ---- Preview images ----------------------------------------------------------

/// Images past this are refused: the bytes travel to the webview as a base64
/// `data:` URI (a third larger again), and a preview is no place for a photo dump.
const IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// MIME type for the image extensions the preview will inline. The allow-list is
/// also the read policy: a document can name any path, so only files that are
/// plainly images are ever read on its behalf.
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

#[derive(Serialize)]
pub struct ImageData {
    /// Absolute path the image resolved to.
    pub path: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<u64>,
    /// The image as a `data:` URI. None when the caller's `known_mtime` still
    /// matches the file: its cached copy is current and nothing was read.
    #[serde(rename = "dataUri")]
    pub data_uri: Option<String>,
}

/// Read an image a Markdown document references, for the preview pane.
///
/// The webview's origin is the app bundle, so a relative `<img src>` there can
/// never reach the document's folder; the preview hands the src here instead and
/// swaps in the returned `data:` URI. That keeps the CSP at `img-src 'self'
/// data:`, and an SVG shown through `<img>` runs no script and loads nothing
/// external. `base` is the document's path — None for an untitled tab, which can
/// then only show absolute paths. `href` is decoded the same way as for
/// `resolve_link`.
///
/// Async so a large image is read off the main thread.
#[tauri::command]
pub async fn read_image(
    base: Option<String>,
    href: String,
    known_mtime: Option<u64>,
) -> Result<ImageData, String> {
    load_image(base.as_deref(), &href, known_mtime)
}

fn load_image(base: Option<&str>, href: &str, known_mtime: Option<u64>) -> Result<ImageData, String> {
    let joined = match base {
        Some(b) => join_link(b, href)?,
        None if Path::new(href).is_absolute() => PathBuf::from(href),
        None => return Err("save this document first to show relative images".to_string()),
    };
    let path = lexical_normalize(&joined);
    let shown = path.to_string_lossy().into_owned();
    let mime = image_mime(&path).ok_or_else(|| format!("{shown}: not a supported image type"))?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("{shown}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{shown}: not a file"));
    }
    if meta.len() > IMAGE_MAX_BYTES {
        return Err(format!(
            "{shown}: image is {} MB, over the {} MB preview limit",
            meta.len() / (1024 * 1024),
            IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }
    let mtime = mtime_ms(&path);
    if mtime.is_some() && mtime == known_mtime {
        return Ok(ImageData { path: shown, mtime_ms: mtime, data_uri: None });
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{shown}: {e}"))?;
    let data_uri = format!("data:{mime};base64,{}", BASE64.encode(bytes));
    Ok(ImageData { path: shown, mtime_ms: mtime, data_uri: Some(data_uri) })
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

    /// The link target as the frontend will see it, for comparison against a
    /// path the test built itself (macOS canonicalizes /var → /private/var).
    fn canon(p: &Path) -> String {
        strip_verbatim(std::fs::canonicalize(p).unwrap())
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn resolve_link_joins_against_the_linking_document() {
        let dir = temp_dir();
        let doc = dir.join("index.md");
        let target = dir.join("aia-control.md");
        std::fs::write(&doc, b"# index\n").unwrap();
        std::fs::write(&target, b"# control\n").unwrap();
        let r = resolve_link(
            doc.to_string_lossy().into_owned(),
            "./aia-control.md".to_string(),
        )
        .unwrap();
        assert!(r.exists);
        assert!(!r.is_dir);
        assert!(!r.binary);
        assert_eq!(r.path, canon(&target));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_link_walks_up_out_of_the_documents_directory() {
        let dir = temp_dir();
        let docs = dir.join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let doc = docs.join("index.md");
        let target = dir.join("README.md");
        std::fs::write(&doc, b"# index\n").unwrap();
        std::fs::write(&target, b"# readme\n").unwrap();
        let r = resolve_link(
            doc.to_string_lossy().into_owned(),
            "../README.md".to_string(),
        )
        .unwrap();
        assert!(r.exists);
        assert_eq!(r.path, canon(&target));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_link_reports_a_missing_target_with_its_resolved_path() {
        let dir = temp_dir();
        let doc = dir.join("index.md");
        std::fs::write(&doc, b"# index\n").unwrap();
        let r = resolve_link(
            doc.to_string_lossy().into_owned(),
            "./nope/../gone.md".to_string(),
        )
        .unwrap();
        assert!(!r.exists);
        // `.` and `..` are folded even though nothing on disk could be consulted.
        assert_eq!(r.path, dir.join("gone.md").to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_link_flags_a_directory() {
        let dir = temp_dir();
        let doc = dir.join("index.md");
        let sub = dir.join("assets");
        std::fs::write(&doc, b"# index\n").unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        let r = resolve_link(doc.to_string_lossy().into_owned(), "assets".to_string()).unwrap();
        assert!(r.exists);
        assert!(r.is_dir);
        assert!(!r.binary); // never sniffed for a directory
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_link_flags_a_binary_target() {
        let dir = temp_dir();
        let doc = dir.join("index.md");
        let bin = dir.join("logo.png");
        let text = dir.join("notes.txt");
        std::fs::write(&doc, b"# index\n").unwrap();
        std::fs::write(&bin, b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR").unwrap();
        std::fs::write(&text, "한글 텍스트\n".as_bytes()).unwrap();
        let base = doc.to_string_lossy().into_owned();
        assert!(resolve_link(base.clone(), "./logo.png".to_string()).unwrap().binary);
        // Multi-byte UTF-8 must not read as binary — only a NUL counts.
        assert!(!resolve_link(base, "./notes.txt".to_string()).unwrap().binary);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_link_takes_an_absolute_href_as_given() {
        let dir = temp_dir();
        let doc = dir.join("index.md");
        let target = dir.join("elsewhere.md");
        std::fs::write(&doc, b"# index\n").unwrap();
        std::fs::write(&target, b"# elsewhere\n").unwrap();
        let r = resolve_link(
            doc.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert!(r.exists);
        assert_eq!(r.path, canon(&target));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_image_inlines_an_svg_relative_to_the_document() {
        let dir = temp_dir();
        let doc = dir.join("index.md");
        std::fs::create_dir_all(dir.join("img")).unwrap();
        std::fs::write(dir.join("img").join("logo.svg"), b"<svg/>").unwrap();
        let base = doc.to_string_lossy().into_owned();
        let img = load_image(Some(&base), "./img/logo.svg", None).unwrap();
        // base64("<svg/>") = PHN2Zy8+
        assert_eq!(img.data_uri.as_deref(), Some("data:image/svg+xml;base64,PHN2Zy8+"));
        assert!(img.mtime_ms.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_image_skips_the_read_when_the_cached_mtime_still_matches() {
        let dir = temp_dir();
        let doc = dir.join("index.md");
        std::fs::write(dir.join("a.PNG"), b"\x89PNG").unwrap();
        let base = doc.to_string_lossy().into_owned();
        let first = load_image(Some(&base), "a.PNG", None).unwrap();
        assert!(first.data_uri.unwrap().starts_with("data:image/png;base64,"));
        let again = load_image(Some(&base), "a.PNG", first.mtime_ms).unwrap();
        assert!(again.data_uri.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_image_refuses_what_is_not_an_image() {
        let dir = temp_dir();
        let doc = dir.join("index.md");
        std::fs::write(dir.join("secret.txt"), b"x").unwrap();
        let base = doc.to_string_lossy().into_owned();
        let err = load_image(Some(&base), "secret.txt", None).err().unwrap();
        assert!(err.contains("not a supported image type"), "unexpected error: {err}");
        assert!(load_image(Some(&base), "missing.svg", None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_image_without_a_base_takes_only_absolute_paths() {
        let dir = temp_dir();
        let svg = dir.join("x.svg");
        std::fs::write(&svg, b"<svg/>").unwrap();
        assert!(load_image(None, &svg.to_string_lossy(), None).unwrap().data_uri.is_some());
        let err = load_image(None, "x.svg", None).err().unwrap();
        assert!(err.contains("save this document first"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
