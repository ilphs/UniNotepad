//! Serde data model for the session manifest (`session.json`).
//!
//! Each window's slice (`WindowSession`) is *composed* by that window's
//! frontend, which owns its live tab state; Rust merges the slices into one
//! manifest and persists it. We keep the structs permissive: fields the
//! frontend adds later that we do not model here are ignored on read, and we
//! round-trip the parts we care about. The manifest is versioned so a format
//! change can migrate rather than discard.
//!
//! ## Versions
//!
//! - v1 — one window: `{version, activeTabId, nextUntitled, tabs}` at the top.
//! - v2 — many windows: `{version, windows: [{label, activeTabId, nextUntitled, tabs}]}`.
//!   A v1 file migrates on read into a single window labelled `main`.
//!
//! One file for all windows (rather than a file per window) is deliberate: the
//! manifest stays a single atomic write, and orphan-backup GC can see every
//! live tab id at once. With per-window files, one window's GC would delete
//! another window's untitled backups.

use serde::{Deserialize, Serialize};

pub const MANIFEST_VERSION: u32 = 2;

/// Label of the one window that existed before multi-window support (the
/// window declared in `tauri.conf.json`). A v1 manifest migrates into it.
pub const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionManifest {
    pub version: u32,
    /// Window order is preserved: restore reopens windows in this order.
    #[serde(default)]
    pub windows: Vec<WindowSession>,
}

/// One window's tabs — the unit the frontend sends in `persist_session` and
/// gets back from `load_session`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSession {
    /// Tauri window label. The frontend never sends it (a webview does not get
    /// to claim another window's slot); `persist_session` stamps it from the
    /// calling window, so it only defaults to empty on the way in.
    #[serde(default)]
    pub label: String,
    #[serde(rename = "activeTabId", default)]
    pub active_tab_id: Option<String>,
    #[serde(rename = "nextUntitled", default = "default_next_untitled")]
    pub next_untitled: u32,
    #[serde(default)]
    pub tabs: Vec<TabEntry>,
}

fn default_next_untitled() -> u32 {
    1
}

impl SessionManifest {
    pub fn empty() -> SessionManifest {
        SessionManifest {
            version: MANIFEST_VERSION,
            windows: Vec::new(),
        }
    }

    /// Parse a manifest of any known version, migrating v1 to v2.
    ///
    /// An unknown version is an error rather than a best-effort parse: the
    /// caller quarantines the file, which keeps it on disk for a newer build to
    /// read. A lenient parse would instead see zero tabs, and the orphan GC
    /// would then delete every backup the newer build had written.
    pub fn parse(raw: &str) -> serde_json::Result<SessionManifest> {
        use serde::de::Error;

        let value: serde_json::Value = serde_json::from_str(raw)?;
        match value.get("version").and_then(serde_json::Value::as_u64) {
            Some(1) => {
                let mut window: WindowSession = serde_json::from_value(value)?;
                window.label = MAIN_WINDOW_LABEL.to_string();
                Ok(SessionManifest {
                    version: MANIFEST_VERSION,
                    windows: vec![window],
                })
            }
            Some(2) => serde_json::from_value(value),
            other => Err(serde_json::Error::custom(format!(
                "unsupported session manifest version: {other:?}"
            ))),
        }
    }

    pub fn window(&self, label: &str) -> Option<&WindowSession> {
        self.windows.iter().find(|w| w.label == label)
    }

    /// Replace the slice for `session.label` in place (keeping window order),
    /// or append it when this window has not persisted before.
    pub fn upsert_window(&mut self, session: WindowSession) {
        match self.windows.iter_mut().find(|w| w.label == session.label) {
            Some(slot) => *slot = session,
            None => self.windows.push(session),
        }
    }

    /// Take a window's slice out (it was closed while others stay open).
    pub fn remove_window(&mut self, label: &str) -> Option<WindowSession> {
        let pos = self.windows.iter().position(|w| w.label == label)?;
        Some(self.windows.remove(pos))
    }

    /// Make sure the `main` label owns a slice whenever there is any.
    ///
    /// The `main` window is the one Tauri always opens at launch (it is in
    /// `tauri.conf.json`); secondary windows are reopened from the manifest.
    /// If the user had closed `main` and quit from a secondary window, the
    /// next launch would otherwise show an empty `main` *next to* the restored
    /// windows. Handing the first slice to `main` instead reopens exactly the
    /// windows the user left, one of them under a different label.
    pub fn ensure_main_window(&mut self) {
        if self.window(MAIN_WINDOW_LABEL).is_none() {
            if let Some(first) = self.windows.first_mut() {
                first.label = MAIN_WINDOW_LABEL.to_string();
            }
        }
    }

    /// Every tab id across all windows — the live set for orphan-backup GC.
    pub fn tab_ids(&self) -> Vec<String> {
        self.windows
            .iter()
            .flat_map(|w| w.tabs.iter().map(|t| t.id.clone()))
            .collect()
    }

    /// The on-disk JSON: v2, plus a v1-shaped mirror of every window flattened
    /// into one (`activeTabId`/`nextUntitled`/`tabs` at the top level).
    ///
    /// The mirror exists for downgrades. A v1 build (≤ 0.10.0) does not check
    /// the version; it would read a bare v2 file as a session with zero tabs,
    /// and its orphan GC would then delete every untitled backup. With the
    /// mirror it restores all tabs into its single window instead, and writes
    /// back a v1 file that `parse` migrates again. That matters in practice:
    /// a dev build and an installed release share one app data dir. v2 readers
    /// ignore the mirror (unknown top-level fields are skipped).
    ///
    /// TODO: drop the mirror once v1 builds are no longer in use.
    pub fn to_disk_json(&self) -> serde_json::Result<String> {
        #[derive(Serialize)]
        struct OnDisk<'a> {
            #[serde(flatten)]
            manifest: &'a SessionManifest,
            #[serde(rename = "activeTabId")]
            active_tab_id: Option<&'a str>,
            #[serde(rename = "nextUntitled")]
            next_untitled: u32,
            tabs: Vec<&'a TabEntry>,
        }

        serde_json::to_string(&OnDisk {
            manifest: self,
            active_tab_id: self.windows.first().and_then(|w| w.active_tab_id.as_deref()),
            // Max, so a v1 build never hands out a number some window already used.
            next_untitled: self.windows.iter().map(|w| w.next_untitled).max().unwrap_or(1),
            tabs: self.windows.iter().flat_map(|w| &w.tabs).collect(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabEntry {
    pub id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub dirty: bool,
    #[serde(rename = "hasBackup", default)]
    pub has_backup: bool,
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub eol: Option<String>,
    /// Explicit file-type pick; absent/null means "detect from the extension".
    /// Modelled so it survives the read/re-serialize round-trip; the frontend
    /// validates the value, so it stays an opaque string here.
    #[serde(rename = "fileType", default)]
    pub file_type: Option<String>,
    #[serde(rename = "diskMtimeMs", default)]
    pub disk_mtime_ms: Option<u64>,
    /// Whether this tab loaded in large-file reduced mode. Absent in older
    /// manifests, so it defaults to false and round-trips otherwise.
    #[serde(rename = "largeFile", default)]
    pub large_file: bool,
    #[serde(default)]
    pub cursor: Option<u64>,
    #[serde(rename = "scrollTop", default)]
    pub scroll_top: Option<f64>,
    // Per-tab view state. These *must* stay modelled here: `load_session`
    // deserializes into this struct and re-serializes the result for the
    // frontend, so any field we do not name is silently dropped on the way back
    // out — the tab would then fall back to a global default on every restart.
    //
    // Every one of them needs `rename` (the frontend writes camelCase) and
    // `default` (older manifests lack them; a missing field would otherwise
    // fail the parse, and `read_manifest` quarantines the whole session on a
    // parse error). `preview_zoom_exp` must be *signed* — zooming out stores
    // negative exponents down to -7.
    #[serde(rename = "previewRatio", default)]
    pub preview_ratio: Option<f64>,
    #[serde(rename = "editorFontSize", default)]
    pub editor_font_size: Option<f64>,
    #[serde(rename = "previewZoomExp", default)]
    pub preview_zoom_exp: Option<i32>,
    /// Whether the editor pane is shown for this tab. Advisory: the frontend
    /// forces the editor back on whenever the preview cannot be shown.
    #[serde(rename = "editorVisible", default)]
    pub editor_visible: Option<bool>,
    #[serde(rename = "previewVisible", default)]
    pub preview_visible: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend composes the manifest and Rust re-serializes what it read,
    /// so every per-tab field has to survive a parse → serialize cycle. A
    /// regression here is invisible at runtime: the tab just silently reverts
    /// to global defaults after a restart.
    #[test]
    fn per_tab_view_state_round_trips() {
        // previewZoomExp is negative when the preview is zoomed out; modelling
        // it as an unsigned type would fail the parse and (via read_manifest)
        // quarantine the entire session.
        let raw = r#"{"version":1,"activeTabId":"a","nextUntitled":3,"tabs":[
            {"id":"a","path":null,"title":"Untitled-1","dirty":true,"hasBackup":true,
             "encoding":"utf8","eol":"lf","fileType":"markdown","diskMtimeMs":null,
             "largeFile":false,"cursor":12,"scrollTop":48.5,
             "previewRatio":0.35,"editorFontSize":18,"previewZoomExp":-3,
             "editorVisible":false,"previewVisible":true}]}"#;

        let parsed = SessionManifest::parse(raw).expect("manifest should parse");
        let tab = &parsed.windows[0].tabs[0];
        assert_eq!(tab.preview_ratio, Some(0.35));
        assert_eq!(tab.editor_font_size, Some(18.0));
        assert_eq!(tab.preview_zoom_exp, Some(-3));
        assert_eq!(tab.editor_visible, Some(false));
        assert_eq!(tab.preview_visible, Some(true));

        let out = serde_json::to_string(&parsed).expect("manifest should serialize");
        let back = SessionManifest::parse(&out).expect("round trip should parse");
        let tab = &back.windows[0].tabs[0];
        assert_eq!(tab.preview_ratio, Some(0.35));
        assert_eq!(tab.editor_font_size, Some(18.0));
        assert_eq!(tab.preview_zoom_exp, Some(-3));
        assert_eq!(tab.editor_visible, Some(false));
        assert_eq!(tab.preview_visible, Some(true));
        // The camelCase keys the frontend reads must be the ones we emit.
        assert!(out.contains("\"previewZoomExp\":-3"));
        assert!(out.contains("\"editorVisible\":false"));
    }

    /// Manifests written before these fields existed must still load; missing
    /// keys become None rather than a parse error.
    #[test]
    fn older_manifest_without_view_state_still_parses() {
        let raw = r#"{"version":1,"activeTabId":"a","nextUntitled":1,"tabs":[
            {"id":"a","title":"a.md","dirty":false,"hasBackup":false}]}"#;

        let parsed = SessionManifest::parse(raw).expect("manifest should parse");
        let tab = &parsed.windows[0].tabs[0];
        assert_eq!(tab.preview_ratio, None);
        assert_eq!(tab.editor_font_size, None);
        assert_eq!(tab.preview_zoom_exp, None);
        assert_eq!(tab.editor_visible, None);
        assert_eq!(tab.preview_visible, None);
    }

    /// A v1 file (the only format before multi-window) becomes one `main`
    /// window with its top-level fields intact, and is written back as v2.
    #[test]
    fn v1_manifest_migrates_into_main_window() {
        let raw = r#"{"version":1,"activeTabId":"b","nextUntitled":4,"tabs":[
            {"id":"a","title":"a.md","dirty":false,"hasBackup":false},
            {"id":"b","path":null,"title":"Untitled-3","dirty":true,"hasBackup":true}]}"#;

        let m = SessionManifest::parse(raw).expect("v1 should parse");
        assert_eq!(m.version, MANIFEST_VERSION);
        assert_eq!(m.windows.len(), 1);
        let w = &m.windows[0];
        assert_eq!(w.label, MAIN_WINDOW_LABEL);
        assert_eq!(w.active_tab_id.as_deref(), Some("b"));
        assert_eq!(w.next_untitled, 4);
        assert_eq!(w.tabs.len(), 2);

        let out = serde_json::to_string(&m).unwrap();
        assert!(out.contains("\"version\":2"));
        assert!(out.contains("\"windows\":["));
    }

    #[test]
    fn v2_manifest_round_trips_every_window_in_order() {
        let raw = r#"{"version":2,"windows":[
            {"label":"main","activeTabId":"a","nextUntitled":2,"tabs":[{"id":"a","title":"x"}]},
            {"label":"win-1","activeTabId":null,"nextUntitled":1,"tabs":[{"id":"b","title":"y"}]}]}"#;

        let m = SessionManifest::parse(raw).expect("v2 should parse");
        let back = SessionManifest::parse(&serde_json::to_string(&m).unwrap()).unwrap();
        let labels: Vec<&str> = back.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["main", "win-1"]);
        assert_eq!(back.window("win-1").unwrap().tabs[0].id, "b");
        assert_eq!(back.tab_ids(), ["a", "b"]);
    }

    /// Unknown versions must fail (→ quarantine) instead of parsing as an
    /// empty session, which would let orphan GC delete a newer build's backups.
    #[test]
    fn unknown_or_missing_version_is_rejected() {
        assert!(SessionManifest::parse(r#"{"version":3,"windows":[]}"#).is_err());
        assert!(SessionManifest::parse(r#"{"tabs":[]}"#).is_err());
    }

    #[test]
    fn upsert_replaces_in_place_or_appends() {
        let win = |label: &str, tab: &str| WindowSession {
            label: label.to_string(),
            active_tab_id: None,
            next_untitled: 1,
            tabs: vec![serde_json::from_str(&format!(r#"{{"id":"{tab}"}}"#)).unwrap()],
        };
        let mut m = SessionManifest::empty();
        m.upsert_window(win("main", "a"));
        m.upsert_window(win("win-1", "b"));
        m.upsert_window(win("main", "c"));

        let labels: Vec<&str> = m.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["main", "win-1"], "replacing main must keep its position");
        assert_eq!(m.tab_ids(), ["c", "b"]);
    }

    /// What a v1 build (≤ 0.10.0) sees when it reads a file written by this
    /// one. Its reader had the `WindowSession` shape (plus `version`, which it
    /// never checked), so parsing the disk JSON as `WindowSession` reproduces
    /// it exactly: it must get every window's tabs, never an empty session.
    #[test]
    fn disk_json_stays_readable_by_v1_builds() {
        let raw = r#"{"version":2,"windows":[
            {"label":"main","activeTabId":"a","nextUntitled":3,"tabs":[{"id":"a"}]},
            {"label":"win-1","activeTabId":"b","nextUntitled":5,"tabs":[{"id":"b"},{"id":"c"}]}]}"#;
        let m = SessionManifest::parse(raw).unwrap();
        let out = m.to_disk_json().unwrap();

        let as_v1: WindowSession = serde_json::from_str(&out).unwrap();
        let ids: Vec<&str> = as_v1.tabs.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(as_v1.active_tab_id.as_deref(), Some("a"));
        assert_eq!(as_v1.next_untitled, 5);

        // And a v2 reader ignores the mirror: windows come back unchanged.
        let back = SessionManifest::parse(&out).unwrap();
        assert_eq!(back.windows.len(), 2);
        assert_eq!(back.window("win-1").unwrap().tabs.len(), 2);
    }

    #[test]
    fn remove_window_takes_only_that_slice() {
        let raw = r#"{"version":2,"windows":[
            {"label":"main","tabs":[{"id":"a"}]},{"label":"win-1","tabs":[{"id":"b"}]}]}"#;
        let mut m = SessionManifest::parse(raw).unwrap();
        let gone = m.remove_window("win-1").expect("slice should exist");
        assert_eq!(gone.tabs[0].id, "b");
        assert_eq!(m.tab_ids(), ["a"]);
        assert!(m.remove_window("win-1").is_none());
    }

    /// Main closed, quit from a secondary window: the first remaining slice
    /// becomes `main`, so launch does not add an empty extra window.
    #[test]
    fn ensure_main_window_adopts_first_slice_only_when_main_is_missing() {
        let mut m = SessionManifest::parse(
            r#"{"version":2,"windows":[{"label":"win-2","tabs":[{"id":"a"}]},{"label":"win-3"}]}"#,
        )
        .unwrap();
        m.ensure_main_window();
        let labels: Vec<&str> = m.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["main", "win-3"]);

        // Already has main: untouched.
        m.ensure_main_window();
        let labels: Vec<&str> = m.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["main", "win-3"]);

        // Empty: nothing to adopt.
        let mut empty = SessionManifest::empty();
        empty.ensure_main_window();
        assert!(empty.windows.is_empty());
    }

    /// The frontend payload carries no label; it must still parse (the command
    /// stamps the label from the calling window).
    #[test]
    fn window_payload_without_label_parses() {
        let w: WindowSession =
            serde_json::from_str(r#"{"activeTabId":null,"nextUntitled":1,"tabs":[]}"#).unwrap();
        assert_eq!(w.label, "");
    }
}
