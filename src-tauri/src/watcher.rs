//! Real-time external file-change watching.
//!
//! Design: we watch each open file's **parent directory** non-recursively (with
//! a refcount so two files in one folder share a single OS watch) rather than
//! the file itself. Watching the file directly is fragile across platforms — an
//! editor that saves via rename-over (temp + rename, exactly what this app does)
//! deletes the original inode, and an inode-based watch (inotify/kqueue) dies
//! silently. Watching the directory survives the rename and behaves the same on
//! Windows, macOS, and Linux.
//!
//! Self-save suppression: `save_file` records the canonical path → post-write
//! mtime in a suppress map; the debouncer callback drops any event whose current
//! on-disk mtime still matches, so the app never reacts to its own writes. The
//! frontend re-checks `mtimeMs === tab.diskMtimeMs` too (belt and suspenders).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Coalesce bursts of filesystem events (e.g. an editor's temp+rename save, or a
/// log being appended to repeatedly) into one notification per file.
const DEBOUNCE_MS: u64 = 500;

/// Canonicalize, falling back to the raw path when it can't be resolved (e.g.
/// the file was just deleted). Keeps watch/unwatch keys stable across a file's
/// brief disappearance during a rename-over save.
fn canonical(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let dur = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as u64)
}

/// Emitted to the frontend when a watched file changes on disk.
#[derive(Serialize, Clone)]
pub struct FileChangedPayload {
    /// The original path string the frontend registered (so it can find its tab).
    pub path: String,
    pub exists: bool,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<u64>,
}

/// Where a watched file lives, resolved once at watch time so unwatch stays
/// correct even if the file has since been deleted (canonicalize would fail).
struct WatchLoc {
    canon: PathBuf,
    parent: Option<PathBuf>,
}

/// State shared with the debouncer callback thread.
#[derive(Default)]
struct Shared {
    /// canonical path → original path string (drives event matching + emit).
    by_canon: HashMap<PathBuf, String>,
    /// original path string → its resolved location (drives lifecycle/unwatch).
    by_orig: HashMap<String, WatchLoc>,
    /// canonical path → mtime we just wrote ourselves, to mute the self-echo.
    suppress: HashMap<PathBuf, u64>,
    /// canonical path → how many tabs currently watch this file. A directory's
    /// refcount only moves when a file's count crosses 0↔1, so Save As over a
    /// path already open in another tab can't double-count the shared directory
    /// (which would strand a sibling's watch or leak the dir refcount on close).
    watch_count: HashMap<PathBuf, usize>,
}

/// Lazily-created debouncer plus the parent-directory watch refcounts.
struct Inner {
    debouncer: Debouncer<RecommendedWatcher>,
    /// parent dir → number of watched files under it (0 entries are removed).
    dirs: HashMap<PathBuf, usize>,
}

pub struct WatcherState {
    shared: Arc<Mutex<Shared>>,
    inner: Mutex<Option<Inner>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        WatcherState {
            shared: Arc::new(Mutex::new(Shared::default())),
            inner: Mutex::new(None),
        }
    }
}

// ---- Pure refcount helpers (unit-tested) -----------------------------------

/// Refcount helper: register one more reference under `dir`. Returns true when
/// it is the first (0→1), i.e. the caller must start the underlying watch. Used
/// for both the parent-directory watches and the per-file `watch_count`.
fn dir_incref(dirs: &mut HashMap<PathBuf, usize>, dir: &Path) -> bool {
    let count = dirs.get(dir).copied().unwrap_or(0);
    dirs.insert(dir.to_path_buf(), count + 1);
    count == 0
}

/// Refcount helper: drop one reference under `dir`. Returns true when the last
/// one left (1→0), i.e. the caller must stop the underlying watch. Used for both
/// the parent-directory watches and the per-file `watch_count`.
fn dir_decref(dirs: &mut HashMap<PathBuf, usize>, dir: &Path) -> bool {
    let count = dirs.get(dir).copied().unwrap_or(0);
    if count <= 1 {
        dirs.remove(dir);
        count == 1
    } else {
        dirs.insert(dir.to_path_buf(), count - 1);
        false
    }
}

/// Decide whether an event for `canon` is the echo of our own save: true when a
/// recorded mtime exists and equals the current on-disk mtime. Consumes the
/// recorded entry either way, so a later genuine edit is never muted.
fn should_suppress(
    suppress: &mut HashMap<PathBuf, u64>,
    canon: &Path,
    current: Option<u64>,
) -> bool {
    match suppress.remove(canon) {
        Some(saved) => current == Some(saved),
        None => false,
    }
}

// ---- Event matching / collection (tempdir-tested) --------------------------

/// Candidate registry keys an event path could correspond to. A directory watch
/// reports the changed child's path; we match it against our canonical keys via
/// (1) canonicalizing the path, (2) the raw path, and (3) canonical-parent +
/// filename — the last still resolves when the file itself was just deleted.
fn candidate_keys(p: &Path) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(c) = std::fs::canonicalize(p) {
        v.push(c);
    }
    v.push(p.to_path_buf());
    if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
        if let Ok(cp) = std::fs::canonicalize(parent) {
            v.push(cp.join(name));
        }
    }
    v
}

/// The registered canonical key an event path maps to, if any.
fn match_registered(by_canon: &HashMap<PathBuf, String>, p: &Path) -> Option<PathBuf> {
    candidate_keys(p).into_iter().find(|c| by_canon.contains_key(c))
}

/// Turn a batch of raw event paths into the notifications to emit: match each to
/// a registered file, drop self-save echoes, and dedupe (one per file per batch).
fn collect_changes(shared: &mut Shared, event_paths: Vec<PathBuf>) -> Vec<FileChangedPayload> {
    let mut out = Vec::new();
    let mut handled: HashSet<PathBuf> = HashSet::new();
    for p in event_paths {
        let Some(canon) = match_registered(&shared.by_canon, &p) else {
            continue;
        };
        if !handled.insert(canon.clone()) {
            continue;
        }
        let current = mtime_ms(&canon);
        if should_suppress(&mut shared.suppress, &canon, current) {
            continue;
        }
        let Some(orig) = shared.by_canon.get(&canon).cloned() else {
            continue;
        };
        out.push(FileChangedPayload {
            path: orig,
            exists: canon.exists(),
            mtime_ms: current,
        });
    }
    out
}

fn handle_events(app: &AppHandle, shared: &Arc<Mutex<Shared>>, paths: Vec<PathBuf>) {
    let payloads = {
        let mut sh = shared.lock().unwrap_or_else(|e| e.into_inner());
        collect_changes(&mut sh, paths)
    };
    for p in payloads {
        let _ = app.emit("file-changed", p);
    }
}

/// Build the debouncer on first use, wiring its callback to `handle_events`.
fn create_inner(app: AppHandle, shared: &Arc<Mutex<Shared>>) -> Result<Inner, String> {
    let shared = shared.clone();
    let debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let paths: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
                if !paths.is_empty() {
                    handle_events(&app, &shared, paths);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(Inner {
        debouncer,
        dirs: HashMap::new(),
    })
}

// ---- Commands --------------------------------------------------------------

#[tauri::command]
pub fn watch_file(app: AppHandle, state: State<WatcherState>, path: String) -> Result<(), String> {
    let canon = canonical(&path);
    let parent = canon.parent().map(|p| p.to_path_buf());

    // Register the file and bump its per-file watch count. `first` is true only
    // when this is the file's very first watcher — the directory watch (below)
    // must start exactly then. A duplicate watch (Save As over a path another tab
    // already holds open) leaves the shared directory's refcount untouched.
    let first = {
        let mut sh = state.shared.lock().unwrap_or_else(|e| e.into_inner());
        sh.by_canon.insert(canon.clone(), path.clone());
        sh.by_orig.insert(
            path,
            WatchLoc {
                canon: canon.clone(),
                parent: parent.clone(),
            },
        );
        dir_incref(&mut sh.watch_count, &canon)
    };

    // No parent (e.g. a bare root) → nothing to watch, but the file is still
    // registered so self-save suppression bookkeeping stays consistent.
    let Some(parent) = parent else {
        return Ok(());
    };

    // Already watched via another tab: the registration above is all that's
    // needed, so don't touch the directory watch.
    if !first {
        return Ok(());
    }

    let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(create_inner(app, &state.shared)?);
    }
    let inner = guard.as_mut().expect("just initialized");
    if dir_incref(&mut inner.dirs, &parent) {
        if let Err(e) = inner
            .debouncer
            .watcher()
            .watch(&parent, RecursiveMode::NonRecursive)
        {
            // Undo both refcounts so a later retry re-attempts the watch.
            dir_decref(&mut inner.dirs, &parent);
            drop(guard);
            let mut sh = state.shared.lock().unwrap_or_else(|e| e.into_inner());
            dir_decref(&mut sh.watch_count, &canon);
            return Err(e.to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(state: State<WatcherState>, path: String) {
    // Drop one watcher for this file. Only when it was the last one do we tear
    // down the registration and (maybe) stop watching the parent directory —
    // otherwise a sibling tab that shares the path would lose its live updates
    // and the directory refcount would leak.
    let parent = {
        let mut sh = state.shared.lock().unwrap_or_else(|e| e.into_inner());
        let Some((canon, parent)) = sh
            .by_orig
            .get(&path)
            .map(|l| (l.canon.clone(), l.parent.clone()))
        else {
            return;
        };
        if !dir_decref(&mut sh.watch_count, &canon) {
            return; // another tab still watches this file
        }
        sh.by_orig.remove(&path);
        sh.by_canon.remove(&canon);
        sh.suppress.remove(&canon);
        parent
    };

    let Some(parent) = parent else {
        return;
    };

    let mut guard = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(inner) = guard.as_mut() {
        if dir_decref(&mut inner.dirs, &parent) {
            let _ = inner.debouncer.watcher().unwatch(&parent);
        }
    }
}

/// Record that we just wrote `path` at `mtime_ms`, so the resulting filesystem
/// event is recognized as our own and suppressed. No-op for unwatched files.
pub fn record_self_save(state: &WatcherState, path: &str, mtime_ms: u64) {
    let canon = canonical(path);
    let mut sh = state.shared.lock().unwrap_or_else(|e| e.into_inner());
    if sh.by_canon.contains_key(&canon) {
        sh.suppress.insert(canon, mtime_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("uninotepad-watch-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // (1) Directory refcount: two files in one folder share a single watch.
    #[test]
    fn dir_refcount_shares_one_watch_for_two_files() {
        let mut dirs: HashMap<PathBuf, usize> = HashMap::new();
        let dir = PathBuf::from("/some/folder");

        // First file → must start watching.
        assert!(dir_incref(&mut dirs, &dir));
        // Second file in the same folder → already watched.
        assert!(!dir_incref(&mut dirs, &dir));
        assert_eq!(dirs.get(&dir).copied(), Some(2));

        // Drop the first → still one file left, keep watching.
        assert!(!dir_decref(&mut dirs, &dir));
        // Drop the last → stop watching, entry removed.
        assert!(dir_decref(&mut dirs, &dir));
        assert!(!dirs.contains_key(&dir));

        // Decref past zero is harmless and reports no unwatch.
        assert!(!dir_decref(&mut dirs, &dir));
    }

    // (1b) Duplicate watch of one file (Save As over a path another tab already
    // holds open) must share a single directory watch, and only the last unwatch
    // may tear it down — mirrors what watch_file/unwatch_file do with the two
    // refcount maps (per-file watch_count gating the per-directory dirs).
    #[test]
    fn duplicate_watch_shares_one_dir_refcount() {
        let mut dirs: HashMap<PathBuf, usize> = HashMap::new();
        let mut watch_count: HashMap<PathBuf, usize> = HashMap::new();
        let dir = PathBuf::from("/folder");
        let canon = PathBuf::from("/folder/file.txt");

        // First watcher of the file → file is new, so the directory watch starts.
        assert!(dir_incref(&mut watch_count, &canon));
        assert!(dir_incref(&mut dirs, &dir));
        assert_eq!(dirs.get(&dir).copied(), Some(1));

        // Second watcher of the SAME file → file already counted, so watch_file
        // returns early and the directory refcount must NOT move.
        assert!(!dir_incref(&mut watch_count, &canon));
        assert_eq!(watch_count.get(&canon).copied(), Some(2));
        assert_eq!(dirs.get(&dir).copied(), Some(1));

        // First unwatch → still one watcher left: registration + dir watch stay.
        assert!(!dir_decref(&mut watch_count, &canon));
        assert_eq!(dirs.get(&dir).copied(), Some(1));

        // Last unwatch → file fully released, so the directory watch stops.
        assert!(dir_decref(&mut watch_count, &canon));
        assert!(!watch_count.contains_key(&canon));
        assert!(dir_decref(&mut dirs, &dir));
        assert!(!dirs.contains_key(&dir));

        // A stray extra unwatch is harmless and reports nothing to tear down.
        assert!(!dir_decref(&mut watch_count, &canon));
    }

    // (2) Suppress judgment: matching mtime mutes, mismatch (or absence) does not.
    #[test]
    fn suppress_matches_only_recorded_mtime() {
        let mut suppress: HashMap<PathBuf, u64> = HashMap::new();
        let p = PathBuf::from("/f.txt");

        // No record → never suppressed.
        assert!(!should_suppress(&mut suppress, &p, Some(100)));

        // Record 100; a 100 event is our own save → suppressed, entry consumed.
        suppress.insert(p.clone(), 100);
        assert!(should_suppress(&mut suppress, &p, Some(100)));
        assert!(!suppress.contains_key(&p));

        // Record 100; a 200 event is a genuine external edit → not suppressed.
        suppress.insert(p.clone(), 100);
        assert!(!should_suppress(&mut suppress, &p, Some(200)));
        assert!(!suppress.contains_key(&p));

        // A delete (no current mtime) against a recorded save → not suppressed.
        suppress.insert(p.clone(), 100);
        assert!(!should_suppress(&mut suppress, &p, None));
    }

    // (3) Integration: real files + collect_changes, no AppHandle needed.
    #[test]
    fn collect_changes_reports_edit_suppresses_self_and_flags_delete() {
        let dir = temp_dir();
        let file = dir.join("note.txt");
        std::fs::write(&file, b"one").unwrap();
        let canon = std::fs::canonicalize(&file).unwrap();
        let orig = file.to_string_lossy().into_owned();

        let mut shared = Shared::default();
        shared.by_canon.insert(canon.clone(), orig.clone());

        // An external edit surfaces as one change for the registered file.
        let changes = collect_changes(&mut shared, vec![file.clone()]);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, orig);
        assert!(changes[0].exists);
        assert!(changes[0].mtime_ms.is_some());

        // A self-save at the current mtime is suppressed (no notification).
        let current = mtime_ms(&canon).unwrap();
        shared.suppress.insert(canon.clone(), current);
        let changes = collect_changes(&mut shared, vec![file.clone()]);
        assert!(changes.is_empty());

        // An unrelated path in the same batch is ignored.
        let other = dir.join("other.txt");
        std::fs::write(&other, b"x").unwrap();
        let changes = collect_changes(&mut shared, vec![other.clone()]);
        assert!(changes.is_empty());

        // Deleting the file is reported with exists=false (matched via the
        // canonical-parent + filename fallback, since the file is gone).
        std::fs::remove_file(&file).unwrap();
        let changes = collect_changes(&mut shared, vec![file.clone()]);
        assert_eq!(changes.len(), 1);
        assert!(!changes[0].exists);
        assert!(changes[0].mtime_ms.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
