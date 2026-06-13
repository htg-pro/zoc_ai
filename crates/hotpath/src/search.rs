//! Ripgrep-style text search. Honours `.gitignore`/`.ignore` via the
//! `ignore` crate; matches lines with a regex; emits structured JSON.

use anyhow::Result;
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct Match {
    pub file: String,
    pub line: usize,
    pub text: String,
}

pub fn search<P: AsRef<Path>>(
    root: P,
    pattern: &str,
    case_insensitive: bool,
    max_results: Option<usize>,
) -> Result<Vec<Match>> {
    let re = RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()?;
    let mut matches = Vec::new();
    'outer: for entry in WalkBuilder::new(root).hidden(false).build().flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        // Skip files that are obviously binary or too large to be useful.
        if let Ok(meta) = entry.metadata() {
            if meta.len() > 2 * 1024 * 1024 {
                continue;
            }
        }
        let Ok(text) = fs::read_to_string(path) else { continue };
        for (idx, line) in text.lines().enumerate() {
            if re.is_match(line) {
                matches.push(Match {
                    file: path.display().to_string(),
                    line: idx + 1,
                    text: line.to_string(),
                });
                if let Some(m) = max_results {
                    if matches.len() >= m {
                        break 'outer;
                    }
                }
            }
        }
    }
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn finds_matches() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.txt"), "hello\nworld\n").unwrap();
        let m = search(td.path(), "world", false, None).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].line, 2);
    }

    #[test]
    fn respects_case_insensitive() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.txt"), "Hello\n").unwrap();
        let m = search(td.path(), "hello", true, None).unwrap();
        assert_eq!(m.len(), 1);
    }
}
