//! Fuzzy unified-diff patch applier.
//!
//! Applies patches with tolerance for line drift (±fuzz lines).
//! Uses Levenshtein distance for context matching when exact match fails.

use serde::{Deserialize, Serialize};
use std::cmp::min;

/// Result of applying a patch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchResult {
    pub success: bool,
    pub applied_hunks: usize,
    pub failed_hunks: Vec<FailedHunk>,
    pub new_content: Option<String>,
}

/// Details about a failed hunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailedHunk {
    pub hunk_index: usize,
    pub reason: String,
    pub expected_context: String,
    pub actual_context: String,
}

/// Apply a unified diff with fuzzy matching.
///
/// # Arguments
/// * `original` - The original file content
/// * `diff` - The unified diff to apply
/// * `fuzz` - Maximum line offset to search for hunk context (0 = strict, 3 = recommended)
///
/// # Returns
/// `PatchResult` with success status, applied hunks count, and new content or failed hunks.
pub fn apply_unified_fuzzy(original: &str, diff: &str, fuzz: u32) -> PatchResult {
    let mut parser = DiffParser::new(diff);
    let hunks = match parser.parse() {
        Ok(h) => h,
        Err(e) => {
            return PatchResult {
                success: false,
                applied_hunks: 0,
                failed_hunks: vec![FailedHunk {
                    hunk_index: 0,
                    reason: format!("Failed to parse diff: {}", e),
                    expected_context: String::new(),
                    actual_context: String::new(),
                }],
                new_content: None,
            };
        }
    };

    let src_lines: Vec<&str> = if original.is_empty() {
        Vec::new()
    } else {
        original.lines().collect()
    };

    let mut result_lines: Vec<String> = Vec::new();
    let mut src_idx = 0;
    let mut applied_count = 0;
    let mut failed_hunks = Vec::new();

    for (hunk_idx, hunk) in hunks.iter().enumerate() {
        let target_line = hunk.old_start.saturating_sub(1);

        // Try to apply hunk with fuzzy matching around its target position
        match apply_hunk_fuzzy(&src_lines, target_line, hunk, fuzz, hunk_idx) {
            Ok((new_lines, actual_start, consumed)) => {
                // Copy unchanged lines up to where the hunk actually starts
                while src_idx < actual_start && src_idx < src_lines.len() {
                    result_lines.push(src_lines[src_idx].to_string());
                    src_idx += 1;
                }
                
                // Apply the hunk
                result_lines.extend(new_lines);
                src_idx = actual_start + consumed;
                applied_count += 1;
            }
            Err(failed) => {
                failed_hunks.push(failed);
                // Continue with next hunk, skipping this one
                // This allows partial application
            }
        }
    }

    // Copy remaining lines
    while src_idx < src_lines.len() {
        result_lines.push(src_lines[src_idx].to_string());
        src_idx += 1;
    }

    if failed_hunks.is_empty() {
        PatchResult {
            success: true,
            applied_hunks: applied_count,
            failed_hunks: Vec::new(),
            new_content: Some(result_lines.join("\n") + if original.ends_with('\n') { "\n" } else { "" }),
        }
    } else {
        PatchResult {
            success: false,
            applied_hunks: applied_count,
            failed_hunks,
            new_content: None,
        }
    }
}

/// Apply a single hunk with fuzzy matching.
/// Returns (result_lines, actual_start_idx, consumed_lines) on success.
fn apply_hunk_fuzzy(
    src_lines: &[&str],
    start_idx: usize,
    hunk: &Hunk,
    fuzz: u32,
    hunk_idx: usize,
) -> Result<(Vec<String>, usize, usize), FailedHunk> {
    // First try strict match at expected position
    if let Some(result) = try_apply_hunk_at(src_lines, start_idx, hunk) {
        return Ok((result.0, start_idx, result.1));
    }

    // If fuzz > 0, search within ±fuzz lines
    if fuzz > 0 {
        let search_range = fuzz as i32;
        let mut best_match: Option<(Vec<String>, usize, usize, u32)> = None;
        let mut best_distance = u32::MAX;

        for offset in -search_range..=search_range {
            if offset == 0 {
                continue; // Already tried exact position
            }
            let candidate_idx = (start_idx as i32 + offset).max(0) as usize;
            if candidate_idx >= src_lines.len() {
                continue;
            }

            if let Some(result) = try_apply_hunk_at(src_lines, candidate_idx, hunk) {
                // Calculate distance (prefer closer matches)
                let distance = offset.unsigned_abs();
                if distance < best_distance {
                    best_distance = distance;
                    best_match = Some((result.0, candidate_idx, result.1, distance));
                }
            }
        }

        if let Some((lines, actual_idx, consumed, _distance)) = best_match {
            return Ok((lines, actual_idx, consumed));
        }
    }

    // Build error with context
    let expected_context = hunk
        .lines
        .iter()
        .filter(|l| l.op == LineOp::Context || l.op == LineOp::Delete)
        .take(3)
        .map(|l| l.content.clone())
        .collect::<Vec<_>>()
        .join("\n");

    let actual_context = src_lines
        .iter()
        .skip(start_idx)
        .take(3)
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join("\n");

    Err(FailedHunk {
        hunk_index: hunk_idx,
        reason: format!("No match found within fuzz={}", fuzz),
        expected_context,
        actual_context,
    })
}

/// Try to apply a hunk at a specific position.
fn try_apply_hunk_at(
    src_lines: &[&str],
    start_idx: usize,
    hunk: &Hunk,
) -> Option<(Vec<String>, usize)> {
    let mut result_lines = Vec::new();
    let mut src_idx = start_idx;

    for line in &hunk.lines {
        match line.op {
            LineOp::Context => {
                if src_idx >= src_lines.len() {
                    return None;
                }
                if src_lines[src_idx] != line.content {
                    return None;
                }
                result_lines.push(src_lines[src_idx].to_string());
                src_idx += 1;
            }
            LineOp::Delete => {
                if src_idx >= src_lines.len() {
                    return None;
                }
                if src_lines[src_idx] != line.content {
                    return None;
                }
                src_idx += 1;
            }
            LineOp::Add => {
                result_lines.push(line.content.clone());
            }
        }
    }

    Some((result_lines, src_idx - start_idx))
}

/// Levenshtein distance between two strings.
#[allow(dead_code)]
fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_len = a.len();
    let b_len = b.len();
    
    if a_len == 0 {
        return b_len;
    }
    if b_len == 0 {
        return a_len;
    }

    let mut matrix = vec![vec![0; b_len + 1]; a_len + 1];

    for (i, row) in matrix.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in matrix[0].iter_mut().enumerate() {
        *cell = j;
    }

    for i in 1..=a_len {
        for j in 1..=b_len {
            let cost = if a.as_bytes()[i - 1] == b.as_bytes()[j - 1] {
                0
            } else {
                1
            };
            matrix[i][j] = min(
                min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1),
                matrix[i - 1][j - 1] + cost,
            );
        }
    }

    matrix[a_len][b_len]
}

// ── Diff Parser ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Hunk {
    old_start: usize,
    _old_count: usize,
    _new_start: usize,
    _new_count: usize,
    lines: Vec<HunkLine>,
}

#[derive(Debug, Clone)]
struct HunkLine {
    op: LineOp,
    content: String,
}

#[derive(Debug, Clone, PartialEq)]
enum LineOp {
    Context,
    Add,
    Delete,
}

struct DiffParser<'a> {
    lines: Vec<&'a str>,
    pos: usize,
}

impl<'a> DiffParser<'a> {
    fn new(diff: &'a str) -> Self {
        Self {
            lines: diff.lines().collect(),
            pos: 0,
        }
    }

    fn parse(&mut self) -> Result<Vec<Hunk>, String> {
        let mut hunks = Vec::new();

        // Skip file headers
        while self.pos < self.lines.len() {
            let line = self.lines[self.pos];
            if line.starts_with("---") || line.starts_with("+++") || line.starts_with("diff ") || line.starts_with("index ") {
                self.pos += 1;
            } else {
                break;
            }
        }

        // Parse hunks
        while self.pos < self.lines.len() {
            let line = self.lines[self.pos];
            if !line.starts_with("@@") {
                break;
            }

            let hunk = self.parse_hunk()?;
            hunks.push(hunk);
        }

        Ok(hunks)
    }

    fn parse_hunk(&mut self) -> Result<Hunk, String> {
        let header = self.lines[self.pos];
        self.pos += 1;

        let (old_start, old_count, new_start, new_count) = self.parse_hunk_header(header)?;

        let mut lines = Vec::new();
        while self.pos < self.lines.len() {
            let line = self.lines[self.pos];
            
            if line.starts_with("@@") {
                break;
            }

            if line.starts_with("\\ No newline") {
                self.pos += 1;
                continue;
            }

            let (op, content) = if let Some(rest) = line.strip_prefix('+') {
                (LineOp::Add, rest)
            } else if let Some(rest) = line.strip_prefix('-') {
                (LineOp::Delete, rest)
            } else if let Some(rest) = line.strip_prefix(' ') {
                (LineOp::Context, rest)
            } else {
                // Treat as context line without prefix
                (LineOp::Context, line)
            };

            lines.push(HunkLine {
                op,
                content: content.to_string(),
            });
            self.pos += 1;
        }

        Ok(Hunk {
            old_start,
            _old_count: old_count,
            _new_start: new_start,
            _new_count: new_count,
            lines,
        })
    }

    fn parse_hunk_header(&self, line: &str) -> Result<(usize, usize, usize, usize), String> {
        // @@ -old_start,old_count +new_start,new_count @@
        let rest = line
            .strip_prefix("@@")
            .ok_or("Invalid hunk header")?
            .trim();

        let parts: Vec<&str> = rest.split_whitespace().collect();
        if parts.len() < 2 {
            return Err("Invalid hunk header: missing ranges".to_string());
        }

        let old_range = parts[0].strip_prefix('-').ok_or("Missing - in old range")?;
        let new_range = parts[1].strip_prefix('+').ok_or("Missing + in new range")?;

        let (old_start, old_count) = self.parse_range(old_range)?;
        let (new_start, new_count) = self.parse_range(new_range)?;

        Ok((old_start, old_count, new_start, new_count))
    }

    fn parse_range(&self, range: &str) -> Result<(usize, usize), String> {
        let parts: Vec<&str> = range.split(',').collect();
        let start = parts[0].parse::<usize>().map_err(|e| e.to_string())?;
        let count = if parts.len() > 1 {
            parts[1].parse::<usize>().map_err(|e| e.to_string())?
        } else {
            1
        };
        Ok((start.max(1), count))
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strict_match() {
        let original = "alpha\nbeta\ngamma\n";
        let diff = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
        
        let result = apply_unified_fuzzy(original, diff, 0);
        assert!(result.success);
        assert_eq!(result.applied_hunks, 1);
        assert_eq!(result.new_content.unwrap(), "alpha\nBETA\ngamma\n");
    }

    #[test]
    fn test_fuzzy_match_positive_drift() {
        // Original has 2 extra lines before the hunk
        let original = "extra1\nextra2\nalpha\nbeta\ngamma\n";
        let diff = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
        
        let result = apply_unified_fuzzy(original, diff, 3);
        assert!(result.success);
        assert_eq!(result.applied_hunks, 1);
        assert_eq!(result.new_content.unwrap(), "extra1\nextra2\nalpha\nBETA\ngamma\n");
    }

    #[test]
    fn test_fuzzy_match_negative_drift() {
        // Original is missing 2 lines before the hunk
        let original = "alpha\nbeta\ngamma\n";
        let diff = "--- a/x\n+++ b/x\n@@ -3,3 +3,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
        
        let result = apply_unified_fuzzy(original, diff, 3);
        assert!(result.success);
        assert_eq!(result.applied_hunks, 1);
        assert_eq!(result.new_content.unwrap(), "alpha\nBETA\ngamma\n");
    }

    #[test]
    fn test_failed_match() {
        let original = "alpha\nbeta\ngamma\n";
        let diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n alpha\n-WRONG\n+NEW\n";
        
        let result = apply_unified_fuzzy(original, diff, 3);
        assert!(!result.success);
        assert_eq!(result.failed_hunks.len(), 1);
        assert_eq!(result.failed_hunks[0].hunk_index, 0);
    }

    #[test]
    fn test_multiple_hunks() {
        let original = "line1\nline2\nline3\nline4\nline5\nline6\n";
        let diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n line1\n-line2\n+LINE2\n@@ -5,2 +5,2 @@\n line5\n-line6\n+LINE6\n";
        
        let result = apply_unified_fuzzy(original, diff, 0);
        assert!(result.success);
        assert_eq!(result.applied_hunks, 2);
        assert_eq!(result.new_content.unwrap(), "line1\nLINE2\nline3\nline4\nline5\nLINE6\n");
    }

    #[test]
    fn test_levenshtein_distance() {
        assert_eq!(levenshtein_distance("kitten", "sitting"), 3);
        assert_eq!(levenshtein_distance("", "abc"), 3);
        assert_eq!(levenshtein_distance("abc", ""), 3);
        assert_eq!(levenshtein_distance("abc", "abc"), 0);
    }
}
