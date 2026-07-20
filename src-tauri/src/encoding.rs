//! Encoding + line-ending detection and (de)serialization.
//!
//! Scope: UTF-8 and UTF-8-with-BOM are detected and preserved. UTF-16 LE/BE are
//! detected via their byte-order mark and round-trip losslessly (encoding_rs has
//! no UTF-16 *encoder*, so we hand-roll it). For files that are not valid UTF-8
//! we run a charset guess (chardetng): Korean EUC-KR/CP949, Japanese Shift-JIS,
//! and Chinese GBK/Big5 are recognized and decoded correctly, and anything else
//! falls back to Latin-1 (windows-1252) so the file still opens without data
//! loss on round-trip within that code page. A few legacy Japanese charsets
//! (EUC-JP, ISO-2022-JP) remain out of scope.
//!
//! Limitation: a UTF-32LE file begins with `FF FE 00 00`, whose `FF FE` prefix
//! is indistinguishable from a UTF-16LE BOM here, so it is mis-sniffed as
//! UTF-16LE. UTF-32 is out of scope.

use serde::{Deserialize, Serialize};

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: [u8; 2] = [0xFF, 0xFE];
const UTF16BE_BOM: [u8; 2] = [0xFE, 0xFF];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Utf8,
    #[serde(rename = "utf8bom")]
    Utf8Bom,
    #[serde(rename = "latin1")]
    Latin1,
    #[serde(rename = "euckr")]
    EucKr,
    #[serde(rename = "sjis")]
    Sjis,
    #[serde(rename = "gbk")]
    Gbk,
    #[serde(rename = "big5")]
    Big5,
    #[serde(rename = "utf16le")]
    Utf16Le,
    #[serde(rename = "utf16be")]
    Utf16Be,
}

impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf8",
            Encoding::Utf8Bom => "utf8bom",
            Encoding::Latin1 => "latin1",
            Encoding::EucKr => "euckr",
            Encoding::Sjis => "sjis",
            Encoding::Gbk => "gbk",
            Encoding::Big5 => "big5",
            Encoding::Utf16Le => "utf16le",
            Encoding::Utf16Be => "utf16be",
        }
    }

    pub fn from_str(s: &str) -> Encoding {
        match s {
            "utf8bom" => Encoding::Utf8Bom,
            "latin1" => Encoding::Latin1,
            "euckr" => Encoding::EucKr,
            "sjis" => Encoding::Sjis,
            "gbk" => Encoding::Gbk,
            "big5" => Encoding::Big5,
            "utf16le" => Encoding::Utf16Le,
            "utf16be" => Encoding::Utf16Be,
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
    /// True when some bytes could not be decoded and were replaced (U+FFFD).
    pub lossy: bool,
}

/// Finalize a decode: detect EOL, normalize to LF, and package the metadata.
fn build_decoded(text: String, encoding: Encoding, lossy: bool) -> Decoded {
    let eol = detect_eol(&text);
    let content = normalize_to_lf(&text);
    Decoded {
        content,
        encoding,
        eol,
        lossy,
    }
}

/// Decode raw file bytes into an LF-normalized string plus detected metadata.
pub fn decode(bytes: &[u8]) -> Decoded {
    // BOM sniffing happens before the UTF-8 validity check. UTF-16 LE/BE are
    // recognized by their BOM and decoded through encoding_rs (BOM stripped
    // first). See the module note re: UTF-32LE (`FF FE 00 00`) being mis-sniffed.
    if let Some(body) = bytes.strip_prefix(&UTF16LE_BOM) {
        let (cow, had_errors) = encoding_rs::UTF_16LE.decode_without_bom_handling(body);
        return build_decoded(cow.into_owned(), Encoding::Utf16Le, had_errors);
    }
    if let Some(body) = bytes.strip_prefix(&UTF16BE_BOM) {
        let (cow, had_errors) = encoding_rs::UTF_16BE.decode_without_bom_handling(body);
        return build_decoded(cow.into_owned(), Encoding::Utf16Be, had_errors);
    }

    let (encoding, body) = if bytes.starts_with(&UTF8_BOM) {
        (Encoding::Utf8Bom, &bytes[UTF8_BOM.len()..])
    } else {
        (Encoding::Utf8, bytes)
    };

    let (text, encoding, lossy) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_string(), encoding, false),
        Err(_) => {
            // Not valid UTF-8 — guess the charset. We special-case the CJK code
            // pages chardetng can commit to (Korean EUC-KR, Japanese Shift-JIS,
            // Chinese GBK/Big5); every other guess decodes through the
            // windows-1252 (Latin-1 superset) fallback, preserving prior behavior.
            // (EUC-JP / ISO-2022-JP are the remaining Japanese gap — they fall
            // through to Latin-1 rather than round-tripping.)
            let mut detector = chardetng::EncodingDetector::new();
            detector.feed(body, true);
            let guess = detector.guess(None, true);
            if guess == encoding_rs::EUC_KR {
                let (cow, _, had) = encoding_rs::EUC_KR.decode(body);
                (cow.into_owned(), Encoding::EucKr, had)
            } else if guess == encoding_rs::SHIFT_JIS {
                let (cow, _, had) = encoding_rs::SHIFT_JIS.decode(body);
                (cow.into_owned(), Encoding::Sjis, had)
            } else if guess == encoding_rs::GBK {
                let (cow, _, had) = encoding_rs::GBK.decode(body);
                (cow.into_owned(), Encoding::Gbk, had)
            } else if guess == encoding_rs::BIG5 {
                let (cow, _, had) = encoding_rs::BIG5.decode(body);
                (cow.into_owned(), Encoding::Big5, had)
            } else {
                let (cow, _, had) = encoding_rs::WINDOWS_1252.decode(body);
                (cow.into_owned(), Encoding::Latin1, had)
            }
        }
    };

    build_decoded(text, encoding, lossy)
}

/// Decode raw bytes forcing a specific encoding (skips detection). Used by the
/// "reinterpret with encoding" path when the user overrides the status-bar
/// picker to fix a mis-guessed file. UTF-8-BOM and UTF-16 LE/BE strip their BOM
/// if present; the other encodings decode the whole buffer through their code
/// page. `lossy` reports whether any byte could not be represented.
pub fn decode_as(bytes: &[u8], encoding: Encoding) -> Decoded {
    let (text, lossy) = match encoding {
        Encoding::Utf8 => match String::from_utf8(bytes.to_vec()) {
            Ok(s) => (s, false),
            Err(_) => (String::from_utf8_lossy(bytes).into_owned(), true),
        },
        Encoding::Utf8Bom => {
            let body = bytes.strip_prefix(&UTF8_BOM).unwrap_or(bytes);
            match String::from_utf8(body.to_vec()) {
                Ok(s) => (s, false),
                Err(_) => (String::from_utf8_lossy(body).into_owned(), true),
            }
        }
        Encoding::Latin1 => {
            let (cow, _, had) = encoding_rs::WINDOWS_1252.decode(bytes);
            (cow.into_owned(), had)
        }
        Encoding::EucKr => {
            let (cow, _, had) = encoding_rs::EUC_KR.decode(bytes);
            (cow.into_owned(), had)
        }
        Encoding::Sjis => {
            let (cow, _, had) = encoding_rs::SHIFT_JIS.decode(bytes);
            (cow.into_owned(), had)
        }
        Encoding::Gbk => {
            let (cow, _, had) = encoding_rs::GBK.decode(bytes);
            (cow.into_owned(), had)
        }
        Encoding::Big5 => {
            let (cow, _, had) = encoding_rs::BIG5.decode(bytes);
            (cow.into_owned(), had)
        }
        Encoding::Utf16Le => {
            let body = bytes.strip_prefix(&UTF16LE_BOM).unwrap_or(bytes);
            let (cow, had) = encoding_rs::UTF_16LE.decode_without_bom_handling(body);
            (cow.into_owned(), had)
        }
        Encoding::Utf16Be => {
            let body = bytes.strip_prefix(&UTF16BE_BOM).unwrap_or(bytes);
            let (cow, had) = encoding_rs::UTF_16BE.decode_without_bom_handling(body);
            (cow.into_owned(), had)
        }
    };

    build_decoded(text, encoding, lossy)
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

/// The result of encoding a string: the bytes plus whether any character could
/// not be represented in the target encoding (and was substituted).
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub lossy: bool,
}

/// Hand-roll a UTF-16 byte stream (encoding_rs has no UTF-16 encoder, per
/// WHATWG). Always emits the BOM. UTF-16 covers the full Unicode range, so this
/// is never lossy.
fn encode_utf16(text: &str, big_endian: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + text.len() * 2);
    if big_endian {
        out.extend_from_slice(&UTF16BE_BOM);
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_be_bytes());
        }
    } else {
        out.extend_from_slice(&UTF16LE_BOM);
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
    }
    out
}

/// Encode an LF-normalized string back to bytes, re-applying EOL and BOM.
/// `lossy` is set when the target code page cannot represent some character.
pub fn encode(content: &str, encoding: Encoding, eol: Eol) -> Encoded {
    let with_eol = match eol {
        Eol::Lf => content.to_string(),
        Eol::Crlf => content.replace('\n', "\r\n"),
    };

    match encoding {
        Encoding::Utf8 => Encoded {
            bytes: with_eol.into_bytes(),
            lossy: false,
        },
        Encoding::Utf8Bom => {
            let mut out = Vec::with_capacity(with_eol.len() + UTF8_BOM.len());
            out.extend_from_slice(&UTF8_BOM);
            out.extend_from_slice(with_eol.as_bytes());
            Encoded {
                bytes: out,
                lossy: false,
            }
        }
        Encoding::Latin1 => {
            let (cow, _, had) = encoding_rs::WINDOWS_1252.encode(&with_eol);
            Encoded {
                bytes: cow.into_owned(),
                lossy: had,
            }
        }
        Encoding::EucKr => {
            // encoding_rs maps unmappable chars to HTML numeric refs (WHATWG) and
            // flags `had_errors`; EUC-KR source round-trips cleanly.
            let (cow, _, had) = encoding_rs::EUC_KR.encode(&with_eol);
            Encoded {
                bytes: cow.into_owned(),
                lossy: had,
            }
        }
        Encoding::Sjis => {
            // Same WHATWG unmappable→HTML-numeric-ref caveat as EUC-KR above;
            // Shift-JIS source round-trips.
            let (cow, _, had) = encoding_rs::SHIFT_JIS.encode(&with_eol);
            Encoded {
                bytes: cow.into_owned(),
                lossy: had,
            }
        }
        Encoding::Gbk => {
            let (cow, _, had) = encoding_rs::GBK.encode(&with_eol);
            Encoded {
                bytes: cow.into_owned(),
                lossy: had,
            }
        }
        Encoding::Big5 => {
            let (cow, _, had) = encoding_rs::BIG5.encode(&with_eol);
            Encoded {
                bytes: cow.into_owned(),
                lossy: had,
            }
        }
        Encoding::Utf16Le => Encoded {
            bytes: encode_utf16(&with_eol, false),
            lossy: false,
        },
        Encoding::Utf16Be => Encoded {
            bytes: encode_utf16(&with_eol, true),
            lossy: false,
        },
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
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, b"hello\nworld\n");
    }

    #[test]
    fn crlf_is_detected_normalized_and_reapplied() {
        let d = decode(b"a\r\nb\r\n");
        assert_eq!(d.eol, Eol::Crlf);
        assert_eq!(d.content, "a\nb\n"); // normalized to LF in memory
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, b"a\r\nb\r\n"); // restored
    }

    #[test]
    fn utf8_bom_is_detected_and_preserved() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"hi");
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Utf8Bom);
        assert_eq!(d.content, "hi");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes);
    }

    #[test]
    fn invalid_utf8_falls_back_to_latin1() {
        // 0xE9 is 'é' in windows-1252 but invalid as standalone UTF-8.
        let d = decode(&[b'c', b'a', b'f', 0xE9]);
        assert_eq!(d.encoding, Encoding::Latin1);
        assert_eq!(d.content, "café");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, vec![b'c', b'a', b'f', 0xE9]);
    }

    #[test]
    fn euckr_korean_is_detected_and_roundtrips() {
        // "한글" in EUC-KR/CP949. Enough Korean bytes for chardetng to commit.
        let (bytes, _, _) = encoding_rs::EUC_KR.encode("한글 테스트입니다\n");
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::EucKr);
        assert_eq!(d.content, "한글 테스트입니다\n");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes.to_vec());
    }

    #[test]
    fn decode_as_forces_euckr_over_detection() {
        // A short EUC-KR buffer chardetng might not commit to; forcing it decodes cleanly.
        let (bytes, _, _) = encoding_rs::EUC_KR.encode("가나");
        let d = decode_as(&bytes, Encoding::EucKr);
        assert_eq!(d.encoding, Encoding::EucKr);
        assert_eq!(d.content, "가나");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes.to_vec());
    }

    #[test]
    fn shift_jis_japanese_is_detected_and_roundtrips() {
        // Kana-heavy sentence so chardetng commits to Shift-JIS rather than a
        // Chinese code page (shared Han ideographs alone are ambiguous).
        let (bytes, _, _) =
            encoding_rs::SHIFT_JIS.encode("これはシフトジスの日本語のテスト文章です。\n");
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Sjis);
        assert_eq!(d.content, "これはシフトジスの日本語のテスト文章です。\n");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes.to_vec());
    }

    #[test]
    fn gbk_simplified_chinese_is_detected_and_roundtrips() {
        // Simplified-only characters (简体、这样) that Big5 cannot represent, so
        // the guess lands on GBK.
        let (bytes, _, _) =
            encoding_rs::GBK.encode("这是一段用来测试简体中文编码的示例文字内容。\n");
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Gbk);
        assert_eq!(d.content, "这是一段用来测试简体中文编码的示例文字内容。\n");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes.to_vec());
    }

    #[test]
    fn big5_traditional_chinese_is_detected_and_roundtrips() {
        // Traditional-only forms (這樣、繁體、編碼) to steer the guess to Big5.
        let (bytes, _, _) =
            encoding_rs::BIG5.encode("這是一段用來測試繁體中文編碼的範例文字內容。\n");
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Big5);
        assert_eq!(d.content, "這是一段用來測試繁體中文編碼的範例文字內容。\n");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes.to_vec());
    }

    #[test]
    fn decode_as_forces_sjis_over_detection() {
        // A short Shift-JIS buffer chardetng might not commit to; forcing it decodes cleanly.
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("テスト");
        let d = decode_as(&bytes, Encoding::Sjis);
        assert_eq!(d.encoding, Encoding::Sjis);
        assert_eq!(d.content, "テスト");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes.to_vec());
    }

    #[test]
    fn decode_as_forces_gbk_over_detection() {
        let (bytes, _, _) = encoding_rs::GBK.encode("测试");
        let d = decode_as(&bytes, Encoding::Gbk);
        assert_eq!(d.encoding, Encoding::Gbk);
        assert_eq!(d.content, "测试");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes.to_vec());
    }

    #[test]
    fn decode_as_forces_big5_over_detection() {
        let (bytes, _, _) = encoding_rs::BIG5.encode("測試");
        let d = decode_as(&bytes, Encoding::Big5);
        assert_eq!(d.encoding, Encoding::Big5);
        assert_eq!(d.content, "測試");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes.to_vec());
    }

    #[test]
    fn from_str_roundtrips_all_encodings() {
        for enc in [
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Latin1,
            Encoding::EucKr,
            Encoding::Sjis,
            Encoding::Gbk,
            Encoding::Big5,
            Encoding::Utf16Le,
            Encoding::Utf16Be,
        ] {
            assert_eq!(Encoding::from_str(enc.as_str()), enc);
        }
    }

    #[test]
    fn utf16le_bom_is_detected_and_roundtrips() {
        // "hi\n" as UTF-16LE with BOM: FF FE, then LE code units.
        let bytes = encode("hi\n", Encoding::Utf16Le, Eol::Lf).bytes;
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Utf16Le);
        assert_eq!(d.eol, Eol::Lf);
        assert_eq!(d.content, "hi\n");
        assert!(!d.lossy);
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes);
    }

    #[test]
    fn utf16be_bom_is_detected_and_roundtrips_with_crlf() {
        // CRLF is normalized to LF on decode and re-applied on encode.
        let bytes = encode("a\nb\n", Encoding::Utf16Be, Eol::Crlf).bytes;
        assert_eq!(&bytes[..2], &[0xFE, 0xFF]);
        let d = decode(&bytes);
        assert_eq!(d.encoding, Encoding::Utf16Be);
        assert_eq!(d.eol, Eol::Crlf);
        assert_eq!(d.content, "a\nb\n");
        assert_eq!(encode(&d.content, d.encoding, d.eol).bytes, bytes);
    }

    #[test]
    fn utf16_surrogate_pair_roundtrips() {
        // U+1F600 (😀) needs a surrogate pair — exercises multi-unit encode/decode.
        for enc in [Encoding::Utf16Le, Encoding::Utf16Be] {
            let bytes = encode("😀 grin\n", enc, Eol::Lf).bytes;
            let d = decode(&bytes);
            assert_eq!(d.encoding, enc);
            assert_eq!(d.content, "😀 grin\n");
            assert!(!d.lossy);
        }
    }

    #[test]
    fn decode_as_forces_utf16le_reinterpret() {
        let bytes = encode("가나다\n", Encoding::Utf16Le, Eol::Lf).bytes;
        let d = decode_as(&bytes, Encoding::Utf16Le);
        assert_eq!(d.encoding, Encoding::Utf16Le);
        assert_eq!(d.content, "가나다\n");
        assert!(!d.lossy);
    }

    #[test]
    fn odd_length_utf16_buffer_does_not_panic() {
        // Trailing half code unit: encoding_rs substitutes U+FFFD, no panic.
        let d = decode(&[0xFF, 0xFE, 0x41, 0x00, 0x42]);
        assert_eq!(d.encoding, Encoding::Utf16Le);
        assert!(d.lossy);
        assert!(d.content.starts_with('A'));
    }

    #[test]
    fn encode_flags_lossy_for_unmappable_char() {
        // An emoji cannot be represented in EUC-KR → lossy encode.
        let e = encode("emoji 😀", Encoding::EucKr, Eol::Lf);
        assert!(e.lossy);
        // A representable string is not flagged.
        let ok = encode("한글\n", Encoding::EucKr, Eol::Lf);
        assert!(!ok.lossy);
    }

    #[test]
    fn decode_as_utf8_flags_lossy_on_invalid_bytes() {
        // 0xFF is never valid UTF-8; forcing UTF-8 replaces it and flags lossy.
        let d = decode_as(&[b'o', b'k', 0xFF], Encoding::Utf8);
        assert!(d.lossy);
        assert!(d.content.starts_with("ok"));
        // Valid UTF-8 forced as UTF-8 is not lossy.
        let clean = decode_as(b"clean", Encoding::Utf8);
        assert!(!clean.lossy);
    }
}
