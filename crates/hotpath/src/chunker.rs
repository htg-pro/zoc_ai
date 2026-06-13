//! Line-based code chunker. Splits a source file into roughly-sized chunks
//! and best-effort extracts a symbol name from the first line of each
//! chunk using a tiny set of language heuristics.
//!
//! A real tree-sitter AST chunker is a future enhancement; the line-based
//! variant is good enough to drive the indexer in Phase 2 and keeps the
//! crate dependency-light.

use anyhow::Result;
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Serialize, Debug)]
pub struct Chunk {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub symbol: Option<String>,
    pub text: String,
}

const DEFAULT_TARGET_LINES: usize = 40;

fn symbol_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?x)
            ^\s*(?:
                (?:pub\s+(?:async\s+)?(?:unsafe\s+)?)?fn\s+(?P<rust>[A-Za-z_][A-Za-z0-9_]*)
              | (?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(?P<js>[A-Za-z_$][A-Za-z0-9_$]*)
              | class\s+(?P<cls>[A-Za-z_][A-Za-z0-9_]*)
              | def\s+(?P<py>[A-Za-z_][A-Za-z0-9_]*)
              | impl\s+(?P<impl>[A-Za-z_][A-Za-z0-9_:<>]*)
              | struct\s+(?P<st>[A-Za-z_][A-Za-z0-9_]*)
              | trait\s+(?P<tr>[A-Za-z_][A-Za-z0-9_]*)
            )",
        )
        .expect("symbol regex compiles")
    })
}

fn extract_symbol(line: &str) -> Option<String> {
    let caps = symbol_re().captures(line)?;
    for name in &["rust", "js", "cls", "py", "impl", "st", "tr"] {
        if let Some(m) = caps.name(name) {
            return Some(m.as_str().to_string());
        }
    }
    None
}

pub fn chunk_file<P: AsRef<Path>>(path: P, target_lines: Option<usize>) -> Result<Vec<Chunk>> {
    let target = target_lines.unwrap_or(DEFAULT_TARGET_LINES).max(4);
    let text = fs::read_to_string(&path)?;
    let path_str = path.as_ref().display().to_string();
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Ok(Vec::new());
    }
    let mut chunks = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let end = (i + target).min(lines.len());
        let slice = &lines[i..end];
        let symbol = slice.iter().find_map(|l| extract_symbol(l));
        chunks.push(Chunk {
            file: path_str.clone(),
            start_line: i + 1,
            end_line: end,
            symbol,
            text: slice.join("\n"),
        });
        i = end;
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn chunks_have_symbols() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "fn alpha() {{}}\nfn beta() {{}}\n").unwrap();
        let c = chunk_file(f.path(), Some(40)).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].symbol.as_deref(), Some("alpha"));
    }

    #[test]
    fn empty_file_yields_no_chunks() {
        let f = NamedTempFile::new().unwrap();
        let c = chunk_file(f.path(), None).unwrap();
        assert!(c.is_empty());
    }
}
