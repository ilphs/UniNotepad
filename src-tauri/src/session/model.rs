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
}
