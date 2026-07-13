//! Encoding + line-ending detection and (de)serialization.
//!
//! v1 scope: UTF-8 and UTF-8-with-BOM are detected and preserved. Anything that
//! is not valid UTF-8 is decoded with a Latin-1 (windows-1252) fallback so the
//! file still opens without data loss on round-trip within that code page.
//! Full charset detection is deferred to a later version.

use serde::{Deserialize, Serialize};

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Utf8,
    #[serde(rename = "utf8bom")]
    Utf8Bom,
    #[serde(rename = "latin1")]
    Latin1,
}

impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf8",
            Encoding::Utf8Bom => "utf8bom",
            Encoding::Latin1 => "latin1",
        }
    }

    pub fn from_str(s: &str) -> Encoding {
        match s {
            "utf8bom" => Encoding::Utf8Bom,
            "latin1" => Encoding::Latin1,
            _ => Encoding::Utf8,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

impl Eol {
    pub fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "lf",
            Eol::Crlf => "crlf",
        }
    }

    pub fn from_str(s: &str) -> Eol {
        match s {
            "crlf" => Eol::Crlf,
            _ => Eol::Lf,
        }
    }

    /// Platform-native default for brand-new documents. (The frontend picks the
    /// new-document EOL today; kept here for Rust-side callers / future use.)
    #[allow(dead_code)]
    pub fn platform_default() -> Eol {
        if cfg!(windows) {
            Eol::Crlf
        } else {
            Eol::Lf
        }
    }
}

/// The result of decoding a byte buffer: content is always normalized to LF.
pub struct Decoded {
    pub content: String,
    pub encoding: Encoding,
    pub eol: Eol,
}

/// Decode raw file bytes into an LF-normalized string plus detected metadata.
pub fn decode(bytes: &[u8]) -> Decoded {
    let (encoding, body) = if bytes.starts_with(&UTF8_BOM) {
        (Encoding::Utf8Bom, &bytes[UTF8_BOM.len()..])
    } else {
        (Encoding::Utf8, bytes)
    };

    let (text, encoding) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_string(), encoding),
        Err(_) => {
            // Not valid UTF-8 — fall back to windows-1252 (Latin-1 superset).
            let (cow, _, _) = encoding_rs::WINDOWS_1252.decode(body);
            (cow.into_owned(), Encoding::Latin1)
        }
    };

    let eol = detect_eol(&text);
    let content = normalize_to_lf(&text);

    Decoded {
        content,
        encoding,
        eol,
    }
}

/// Detect the dominant line ending. CRLF wins if any CRLF is present.
fn detect_eol(text: &str) -> Eol {
    if text.contains("\r\n") {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

/// Collapse all line endings to LF (CodeMirror always works in LF).
fn normalize_to_lf(text: &str) -> String {
    // Handle CRLF first, then any stray CR.
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Encode an LF-normalized string back to bytes, re-applying EOL and BOM.
pub fn encode(content: &str, encoding: Encoding, eol: Eol) -> Vec<u8> {
    let with_eol = match eol {
        Eol::Lf => content.to_string(),
        Eol::Crlf => content.replace('\n', "\r\n"),
    };

    match encoding {
        Encoding::Utf8 => with_eol.into_bytes(),
        Encoding::Utf8Bom => {
            let mut out = Vec::with_capacity(with_eol.len() + UTF8_BOM.len());
            out.extend_from_slice(&UTF8_BOM);
            out.extend_from_slice(with_eol.as_bytes());
            out
        }
        Encoding::Latin1 => {
            let (cow, _, _) = encoding_rs::WINDOWS_1252.encode(&with_eol);
            cow.into_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_plain_lf_roundtrip() {
        let d = decode(b"hello\nworld\n");
        assert_eq!(d.encoding, Encoding::Utf8);
        assert_eq!(d.eol, Eol::Lf);
        assert_eq!(d.content, "hello\nworld\n");
        assert_eq!(encode(&d.content, d.encoding, d.eol), b"hello\nworld\n");
    }

    #[test]
    fn crlf_is_detected_normalized_and_reapplied() {
        let d = decode(b"a\r\nb\r\n");
        assert_eq!(d.eol, Eol::Crlf);
        assert_eq!(d.content, "a\nb\n"); // normalized to LF in memory
        assert_eq!(encode(&d.content, d.encoding, d.eol), b"a\r\nb\r\n"); // restored
    }

    #[test]
    fn utf8_bom_is_detected_and_preserved() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"hi");
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Utf8Bom);
        assert_eq!(d.content, "hi");
        assert_eq!(encode(&d.content, d.encoding, d.eol), bytes);
    }

    #[test]
    fn invalid_utf8_falls_back_to_latin1() {
        // 0xE9 is 'é' in windows-1252 but invalid as standalone UTF-8.
        let d = decode(&[b'c', b'a', b'f', 0xE9]);
        assert_eq!(d.encoding, Encoding::Latin1);
        assert_eq!(d.content, "café");
        assert_eq!(encode(&d.content, d.encoding, d.eol), vec![b'c', b'a', b'f', 0xE9]);
    }
}
