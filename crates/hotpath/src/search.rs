//! Ripgrep-style text search. Honours `.gitignore`/`.ignore` via the
//! `ignore` crate; matches lines with a regex; emits structured JSON.

use anyhow::Result;
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
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

// ── Rich workspace search & replace (develop.md Phase 3) ──────────────────
//
// Adds regex/case/whole-word toggles, include/exclude globs, a `.gitignore`
// toggle, per-line/column match spans grouped by file, and a preview→apply
// replace flow. Used by the desktop `fs_search` / `fs_replace_*` commands.

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 1000;
// Always skip these heavy dirs even when .gitignore is disabled, so a search
// never crawls into dependency/build output.
const ALWAYS_EXCLUDE: &[&str] = &[
    "!**/node_modules/**",
    "!**/.git/**",
    "!**/target/**",
    "!**/dist/**",
    "!**/.venv/**",
    "!**/__pycache__/**",
    "!**/.next/**",
];

#[derive(Deserialize, Debug, Clone)]
pub struct SearchOptions {
    pub query: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default = "default_true")]
    pub use_gitignore: bool,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

fn default_true() -> bool {
    true
}
fn default_max_results() -> usize {
    5000
}

#[derive(Serialize, Debug, Clone)]
pub struct LineMatch {
    pub line: usize,
    pub column: usize,
    pub start: usize,
    pub end: usize,
    pub text: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct FileMatches {
    pub file: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Serialize, Debug, Clone)]
pub struct SearchResults {
    pub files: Vec<FileMatches>,
    pub total: usize,
    pub truncated: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ReplaceOptions {
    #[serde(flatten)]
    pub search: SearchOptions,
    pub replacement: String,
    /// Optional subset of files (absolute paths) to limit the replace to.
    #[serde(default)]
    pub paths: Option<Vec<String>>,
}

#[derive(Serialize, Debug, Clone)]
pub struct LinePreview {
    pub line: usize,
    pub before: String,
    pub after: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct FileReplace {
    pub file: String,
    pub replacements: usize,
    pub previews: Vec<LinePreview>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ReplacedFile {
    pub file: String,
    pub replacements: usize,
    /// Pre-replace content, so the caller can offer an undo.
    pub original: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct ReplaceSummary {
    pub files: Vec<ReplacedFile>,
    pub total_replacements: usize,
}

fn build_regex(opts: &SearchOptions) -> Result<Regex> {
    let mut pat = if opts.is_regex {
        opts.query.clone()
    } else {
        regex::escape(&opts.query)
    };
    if opts.whole_word {
        pat = format!(r"\b(?:{pat})\b");
    }
    Ok(RegexBuilder::new(&pat)
        .case_insensitive(!opts.case_sensitive)
        .build()?)
}

fn build_walk(root: &Path, opts: &SearchOptions) -> Result<ignore::Walk> {
    let mut ob = OverrideBuilder::new(root);
    for inc in opts.includes.iter().filter(|g| !g.trim().is_empty()) {
        ob.add(inc)?;
    }
    for exc in opts.excludes.iter().filter(|g| !g.trim().is_empty()) {
        ob.add(&format!("!{exc}"))?;
    }
    for g in ALWAYS_EXCLUDE {
        ob.add(g)?;
    }
    let overrides = ob.build()?;
    let mut wb = WalkBuilder::new(root);
    wb.hidden(false)
        .overrides(overrides)
        .git_ignore(opts.use_gitignore)
        .git_global(opts.use_gitignore)
        .git_exclude(opts.use_gitignore)
        .ignore(opts.use_gitignore)
        .parents(opts.use_gitignore);
    Ok(wb.build())
}

fn clip(line: &str) -> String {
    if line.chars().count() > MAX_LINE_CHARS {
        line.chars().take(MAX_LINE_CHARS).collect()
    } else {
        line.to_string()
    }
}

/// Search every text file under `root`, grouped by file. `paths`, when set,
/// limits results to that subset (used so replace previews/applies operate on
/// the same files the user selected).
pub fn grep(root: &Path, opts: &SearchOptions, paths: Option<&[String]>) -> Result<SearchResults> {
    let re = build_regex(opts)?;
    let mut files: Vec<FileMatches> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    'outer: for entry in build_walk(root, opts)?.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let path_s = path.display().to_string();
        if let Some(allow) = paths {
            if !allow.iter().any(|p| p == &path_s) {
                continue;
            }
        }
        if let Ok(meta) = entry.metadata() {
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
        }
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let mut file_matches: Vec<LineMatch> = Vec::new();
        for (idx, line) in text.lines().enumerate() {
            for m in re.find_iter(line) {
                let column = line[..m.start()].chars().count();
                let end = line[..m.end()].chars().count();
                file_matches.push(LineMatch {
                    line: idx + 1,
                    column: column + 1,
                    start: column,
                    end,
                    text: clip(line),
                });
                total += 1;
                if total >= opts.max_results {
                    truncated = true;
                    if !file_matches.is_empty() {
                        files.push(FileMatches {
                            file: path_s.clone(),
                            matches: file_matches,
                        });
                    }
                    break 'outer;
                }
            }
        }
        if !file_matches.is_empty() {
            files.push(FileMatches {
                file: path_s,
                matches: file_matches,
            });
        }
    }
    Ok(SearchResults {
        files,
        total,
        truncated,
    })
}

/// Apply `re`/`replacement` line-by-line, preserving the original line
/// structure (including `\r\n` and a trailing newline). Returns the new
/// content, the replacement count, and the changed-line previews.
fn replace_in_text(re: &Regex, replacement: &str, text: &str) -> (String, usize, Vec<LinePreview>) {
    let mut count = 0usize;
    let mut previews = Vec::new();
    let parts: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(parts.len());
    for (idx, part) in parts.iter().enumerate() {
        let n = re.find_iter(part).count();
        if n == 0 {
            out.push((*part).to_string());
            continue;
        }
        count += n;
        let after = re.replace_all(part, replacement).into_owned();
        previews.push(LinePreview {
            line: idx + 1,
            before: clip(part),
            after: clip(&after),
        });
        out.push(after);
    }
    (out.join("\n"), count, previews)
}

pub fn replace_preview(root: &Path, opts: &ReplaceOptions) -> Result<Vec<FileReplace>> {
    let re = build_regex(&opts.search)?;
    let found = grep(root, &opts.search, opts.paths.as_deref())?;
    let mut out = Vec::new();
    for fm in found.files {
        let Ok(text) = fs::read_to_string(&fm.file) else {
            continue;
        };
        let (_, count, previews) = replace_in_text(&re, &opts.replacement, &text);
        if count > 0 {
            out.push(FileReplace {
                file: fm.file,
                replacements: count,
                previews,
            });
        }
    }
    Ok(out)
}

pub fn replace_apply(root: &Path, opts: &ReplaceOptions) -> Result<ReplaceSummary> {
    let re = build_regex(&opts.search)?;
    let found = grep(root, &opts.search, opts.paths.as_deref())?;
    let mut files = Vec::new();
    let mut total = 0usize;
    for fm in found.files {
        let Ok(original) = fs::read_to_string(&fm.file) else {
            continue;
        };
        let (new_content, count, _) = replace_in_text(&re, &opts.replacement, &original);
        if count == 0 || new_content == original {
            continue;
        }
        fs::write(&fm.file, &new_content)?;
        total += count;
        files.push(ReplacedFile {
            file: fm.file,
            replacements: count,
            original,
        });
    }
    Ok(ReplaceSummary {
        files,
        total_replacements: total,
    })
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

    fn opts(query: &str) -> SearchOptions {
        SearchOptions {
            query: query.into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            includes: vec![],
            excludes: vec![],
            use_gitignore: false,
            max_results: 5000,
        }
    }

    #[test]
    fn grep_groups_by_file_with_columns() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.ts"), "let foo = 1;\nlet bar = foo + foo;\n").unwrap();
        let res = grep(td.path(), &opts("foo"), None).unwrap();
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.total, 3);
        let first = &res.files[0].matches[0];
        assert_eq!(first.line, 1);
        assert_eq!(first.column, 5); // 1-based column of "foo"
    }

    #[test]
    fn whole_word_and_case_sensitivity() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.ts"), "foo foobar Foo\n").unwrap();
        let mut o = opts("foo");
        o.whole_word = true;
        // case-insensitive whole-word → "foo" and "Foo" but not "foobar"
        assert_eq!(grep(td.path(), &o, None).unwrap().total, 2);
        o.case_sensitive = true;
        assert_eq!(grep(td.path(), &o, None).unwrap().total, 1);
    }

    #[test]
    fn include_exclude_globs() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.ts"), "needle\n").unwrap();
        fs::write(td.path().join("b.md"), "needle\n").unwrap();
        let mut o = opts("needle");
        o.includes = vec!["*.ts".into()];
        let res = grep(td.path(), &o, None).unwrap();
        assert_eq!(res.files.len(), 1);
        assert!(res.files[0].file.ends_with("a.ts"));
    }

    #[test]
    fn regex_matches_and_truncation() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.ts"), "a1\na2\na3\n").unwrap();
        let mut o = opts(r"a\d");
        o.is_regex = true;
        o.max_results = 2;
        let res = grep(td.path(), &o, None).unwrap();
        assert_eq!(res.total, 2);
        assert!(res.truncated);
    }

    #[test]
    fn replace_preview_and_apply_roundtrip() {
        let td = tempdir().unwrap();
        let f = td.path().join("a.ts");
        fs::write(&f, "let foo = foo;\nbar\n").unwrap();
        let ropts = ReplaceOptions {
            search: opts("foo"),
            replacement: "baz".into(),
            paths: None,
        };
        let preview = replace_preview(td.path(), &ropts).unwrap();
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].replacements, 2);
        assert_eq!(preview[0].previews[0].after, "let baz = baz;");
        // File is untouched by preview.
        assert_eq!(fs::read_to_string(&f).unwrap(), "let foo = foo;\nbar\n");

        let summary = replace_apply(td.path(), &ropts).unwrap();
        assert_eq!(summary.total_replacements, 2);
        assert_eq!(fs::read_to_string(&f).unwrap(), "let baz = baz;\nbar\n");
        // The original is returned for undo and round-trips exactly.
        assert_eq!(summary.files[0].original, "let foo = foo;\nbar\n");
    }

    #[test]
    fn regex_capture_group_replacement() {
        let td = tempdir().unwrap();
        let f = td.path().join("a.ts");
        fs::write(&f, "color: red;\n").unwrap();
        let mut s = opts(r"color: (\w+)");
        s.is_regex = true;
        let ropts = ReplaceOptions {
            search: s,
            replacement: "colour: $1".into(),
            paths: None,
        };
        replace_apply(td.path(), &ropts).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "colour: red;\n");
    }
}
