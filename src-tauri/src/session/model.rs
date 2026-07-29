//! Serde data model for the session manifest (`session.json`).
//!
//! The manifest is *composed* by the frontend (which owns live tab state) and
//! merely *persisted* by Rust. We keep the struct permissive: fields the
//! frontend adds later that we do not model here are ignored on read, and we
//! round-trip the parts we care about. The manifest is versioned so a future
//! format change can migrate rather than discard.

use serde::{Deserialize, Serialize};

#[allow(dead_code)]
pub const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionManifest {
    pub version: u32,
    #[serde(rename = "activeTabId")]
    pub active_tab_id: Option<String>,
    #[serde(rename = "nextUntitled", default = "default_next_untitled")]
    pub next_untitled: u32,
    #[serde(default)]
    pub tabs: Vec<TabEntry>,
}

fn default_next_untitled() -> u32 {
    1
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

        let parsed: SessionManifest = serde_json::from_str(raw).expect("manifest should parse");
        let tab = &parsed.tabs[0];
        assert_eq!(tab.preview_ratio, Some(0.35));
        assert_eq!(tab.editor_font_size, Some(18.0));
        assert_eq!(tab.preview_zoom_exp, Some(-3));
        assert_eq!(tab.editor_visible, Some(false));
        assert_eq!(tab.preview_visible, Some(true));

        let out = serde_json::to_string(&parsed).expect("manifest should serialize");
        let back: SessionManifest = serde_json::from_str(&out).expect("round trip should parse");
        let tab = &back.tabs[0];
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

        let parsed: SessionManifest = serde_json::from_str(raw).expect("manifest should parse");
        let tab = &parsed.tabs[0];
        assert_eq!(tab.preview_ratio, None);
        assert_eq!(tab.editor_font_size, None);
        assert_eq!(tab.preview_zoom_exp, None);
        assert_eq!(tab.editor_visible, None);
        assert_eq!(tab.preview_visible, None);
    }
}
