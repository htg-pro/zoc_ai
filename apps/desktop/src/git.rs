//! Source control commands (develop.md Phase 4).
//!
//! Thin, workspace-scoped wrappers over the `git` CLI. We shell out rather than
//! link libgit2 to keep the dependency surface small and behavior identical to
//! the user's own git. Every command runs with `current_dir` = the active
//! workspace root, and any file paths the renderer supplies are validated with
//! `ensure_within_workspace` before they reach git.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use serde::Serialize;

use crate::workspace::{ensure_within_workspace, WorkspaceState};

#[derive(Serialize, Debug, Clone)]
pub struct GitEntry {
    pub path: String,
    pub x: String,
    pub y: String,
    pub label: String,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub staged: Vec<GitEntry>,
    pub unstaged: Vec<GitEntry>,
    pub untracked: Vec<GitEntry>,
    pub conflicts: Vec<GitEntry>,
}

#[derive(Serialize, Debug, Clone)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub subject: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct BlameLine {
    pub line: usize,
    pub sha: String,
    pub author: String,
    pub summary: String,
}

fn root_dir(workspace: &WorkspaceState) -> Result<std::path::PathBuf, String> {
    workspace
        .get()
        .ok_or_else(|| "no workspace root configured".to_string())
}

/// Run git in the workspace root. Returns stdout on success, the trimmed
/// stderr (or a synthetic message) on failure.
fn git(workspace: &WorkspaceState, args: &[&str]) -> Result<String, String> {
    let root = root_dir(workspace)?;
    let out = Command::new("git")
        .current_dir(&root)
        .args(args)
        .output()
        .map_err(|e| format!("git is not available on PATH: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("git {} failed", args.first().copied().unwrap_or(""))
        } else {
            err
        })
    }
}

/// Validate each renderer-supplied path and return absolute strings safe to
/// pass to git after `--`.
fn safe_paths(workspace: &WorkspaceState, paths: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let resolved = ensure_within_workspace(workspace, Path::new(p))?;
        out.push(resolved.to_string_lossy().into_owned());
    }
    Ok(out)
}

fn label_for(x: char, y: char) -> String {
    if x == '?' && y == '?' {
        return "Untracked".into();
    }
    if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return "Conflict".into();
    }
    let c = if x != ' ' && x != '?' { x } else { y };
    match c {
        'M' => "Modified",
        'A' => "Added",
        'D' => "Deleted",
        'R' => "Renamed",
        'C' => "Copied",
        'T' => "Type changed",
        _ => "Changed",
    }
    .to_string()
}

fn is_conflict(x: char, y: char) -> bool {
    matches!(
        (x, y),
        ('D', 'D') | ('A', 'A') | ('U', _) | (_, 'U')
    )
}

fn parse_branch_header(line: &str, status: &mut GitStatus) {
    // Forms: "## main", "## main...origin/main [ahead 1, behind 2]",
    //        "## HEAD (no branch)".
    let rest = line.trim_start_matches("## ").trim();
    if rest.starts_with("HEAD (no branch)") {
        status.branch = None;
        return;
    }
    let (branch_part, track_part) = match rest.find(" [") {
        Some(i) => (&rest[..i], &rest[i + 2..rest.len().saturating_sub(1)]),
        None => (rest, ""),
    };
    if let Some(i) = branch_part.find("...") {
        status.branch = Some(branch_part[..i].to_string());
        status.upstream = Some(branch_part[i + 3..].to_string());
    } else {
        status.branch = Some(branch_part.to_string());
    }
    for token in track_part.split(", ") {
        if let Some(n) = token.strip_prefix("ahead ") {
            status.ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = token.strip_prefix("behind ") {
            status.behind = n.trim().parse().unwrap_or(0);
        }
    }
}

/// Full working-tree status, grouped into staged / unstaged / untracked /
/// conflicts. Returns `is_repo: false` (not an error) when the workspace isn't
/// a git repository, so the UI can show an honest empty state.
#[tauri::command]
pub fn git_status(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    _root: Option<String>,
) -> Result<GitStatus, String> {
    if git(&workspace, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(GitStatus {
            is_repo: false,
            ..Default::default()
        });
    }
    let raw = git(&workspace, &["status", "--porcelain=v1", "--branch", "-z"])?;
    let mut status = parse_status(&raw);
    status.is_repo = true;
    Ok(status)
}

/// Parse `git status --porcelain=v1 --branch -z` output into grouped lists.
/// Pure so it can be unit-tested without a git repo.
pub fn parse_status(raw: &str) -> GitStatus {
    let mut status = GitStatus::default();
    let mut parts = raw.split('\0');
    while let Some(record) = parts.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(rest) = record.strip_prefix("## ") {
            parse_branch_header(&format!("## {rest}"), &mut status);
            continue;
        }
        if record.len() < 3 {
            continue;
        }
        let bytes: Vec<char> = record.chars().collect();
        let x = bytes[0];
        let y = bytes[1];
        let path: String = record[3..].to_string();
        // A rename record is followed by the original path (consume + ignore).
        if x == 'R' || x == 'C' {
            let _ = parts.next();
        }
        let entry = GitEntry {
            path,
            x: x.to_string(),
            y: y.to_string(),
            label: label_for(x, y),
        };
        if x == '?' && y == '?' {
            status.untracked.push(entry);
        } else if is_conflict(x, y) {
            status.conflicts.push(entry);
        } else {
            if x != ' ' {
                status.staged.push(entry.clone());
            }
            if y != ' ' {
                status.unstaged.push(entry);
            }
        }
    }
    status
}

#[tauri::command]
pub fn git_diff(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
    staged: bool,
) -> Result<String, String> {
    let abs = safe_paths(&workspace, std::slice::from_ref(&path))?;
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&abs[0]);
    git(&workspace, &args)
}

#[tauri::command]
pub fn git_stage(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    paths: Vec<String>,
) -> Result<(), String> {
    let abs = safe_paths(&workspace, &paths)?;
    let mut args = vec!["add", "--"];
    args.extend(abs.iter().map(String::as_str));
    git(&workspace, &args).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    paths: Vec<String>,
) -> Result<(), String> {
    let abs = safe_paths(&workspace, &paths)?;
    let mut args = vec!["reset", "-q", "HEAD", "--"];
    args.extend(abs.iter().map(String::as_str));
    git(&workspace, &args).map(|_| ())
}

/// Discard worktree changes for tracked files (destructive — the UI confirms).
#[tauri::command]
pub fn git_discard(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    paths: Vec<String>,
) -> Result<(), String> {
    let abs = safe_paths(&workspace, &paths)?;
    let mut args = vec!["checkout", "--"];
    args.extend(abs.iter().map(String::as_str));
    git(&workspace, &args).map(|_| ())
}

#[tauri::command]
pub fn git_commit(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    message: String,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is required".into());
    }
    git(&workspace, &["commit", "-m", &message])?;
    Ok(git(&workspace, &["rev-parse", "HEAD"])?.trim().to_string())
}

#[tauri::command]
pub fn git_checkpoint_commit(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    message: String,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is required".into());
    }
    git(&workspace, &["add", "-A"])?;
    git(&workspace, &["commit", "--allow-empty", "-m", &message])?;
    Ok(git(&workspace, &["rev-parse", "HEAD"])?.trim().to_string())
}

#[tauri::command]
pub fn git_branches(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
) -> Result<Vec<GitBranch>, String> {
    let raw = git(
        &workspace,
        &["branch", "--format=%(HEAD)%00%(refname:short)"],
    )?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut it = line.splitn(2, '\0');
        let head = it.next().unwrap_or("");
        let name = it.next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        out.push(GitBranch {
            name: name.to_string(),
            current: head.trim() == "*",
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn git_checkout(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    branch: String,
) -> Result<(), String> {
    git(&workspace, &["checkout", &branch]).map(|_| ())
}

#[tauri::command]
pub fn git_create_branch(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    name: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("branch name is required".into());
    }
    git(&workspace, &["checkout", "-b", name.trim()]).map(|_| ())
}

#[tauri::command]
pub fn git_pull(workspace: tauri::State<'_, Arc<WorkspaceState>>) -> Result<String, String> {
    git(&workspace, &["pull", "--ff-only"])
}

#[tauri::command]
pub fn git_push(workspace: tauri::State<'_, Arc<WorkspaceState>>) -> Result<String, String> {
    // If the branch has no upstream, set it on first push.
    match git(&workspace, &["push"]) {
        Ok(o) => Ok(o),
        Err(e) if e.contains("no upstream") || e.contains("--set-upstream") => {
            let branch = git(&workspace, &["rev-parse", "--abbrev-ref", "HEAD"])?
                .trim()
                .to_string();
            git(&workspace, &["push", "-u", "origin", &branch])
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn git_log(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>, String> {
    let n = format!("-n{}", limit.unwrap_or(50));
    // Field sep \x1f, record sep \x1e.
    let raw = git(
        &workspace,
        &[
            "log",
            &n,
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1e",
        ],
    )?;
    let mut out = Vec::new();
    for record in raw.split('\u{1e}') {
        let record = record.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = record.split('\u{1f}').collect();
        if f.len() < 6 {
            continue;
        }
        out.push(GitCommit {
            hash: f[0].to_string(),
            short: f[1].to_string(),
            author: f[2].to_string(),
            email: f[3].to_string(),
            timestamp: f[4].trim().parse().unwrap_or(0),
            subject: f[5].to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn git_conflicts(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
) -> Result<Vec<String>, String> {
    let raw = git(
        &workspace,
        &["diff", "--name-only", "--diff-filter=U", "-z"],
    )?;
    Ok(raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect())
}

#[tauri::command]
pub fn git_blame(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
) -> Result<Vec<BlameLine>, String> {
    let abs = safe_paths(&workspace, std::slice::from_ref(&path))?;
    let raw = git(&workspace, &["blame", "--line-porcelain", "--", &abs[0]])?;
    let mut out = Vec::new();
    let mut sha = String::new();
    let mut author = String::new();
    let mut summary = String::new();
    let mut line_no = 0usize;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("author ") {
            author = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("summary ") {
            summary = rest.to_string();
        } else if line.starts_with('\t') {
            line_no += 1;
            out.push(BlameLine {
                line: line_no,
                sha: sha.chars().take(8).collect(),
                author: author.clone(),
                summary: summary.clone(),
            });
        } else if let Some(first) = line.split(' ').next() {
            // A header line begins with a 40-char sha.
            if first.len() == 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
                sha = first.to_string();
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_with_upstream_and_tracking() {
        let mut s = GitStatus::default();
        parse_branch_header("## main...origin/main [ahead 2, behind 1]", &mut s);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
    }

    #[test]
    fn parses_plain_branch_and_detached_head() {
        let mut s = GitStatus::default();
        parse_branch_header("## feature/x", &mut s);
        assert_eq!(s.branch.as_deref(), Some("feature/x"));
        let mut d = GitStatus::default();
        parse_branch_header("## HEAD (no branch)", &mut d);
        assert!(d.branch.is_none());
    }

    #[test]
    fn groups_files_into_staged_unstaged_untracked_conflicts() {
        // "## branch" + staged-add, worktree-modified, both, untracked, conflict.
        let raw = "## main\0A  added.ts\0 M worktree.ts\0MM both.ts\0?? new.ts\0UU conflict.ts\0";
        let s = parse_status(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        // added.ts (staged), both.ts (staged side)
        assert_eq!(s.staged.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["added.ts", "both.ts"]);
        // worktree.ts + both.ts (worktree side)
        assert_eq!(s.unstaged.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["worktree.ts", "both.ts"]);
        assert_eq!(s.untracked.len(), 1);
        assert_eq!(s.untracked[0].path, "new.ts");
        assert_eq!(s.conflicts.len(), 1);
        assert_eq!(s.conflicts[0].path, "conflict.ts");
        assert_eq!(s.conflicts[0].label, "Conflict");
    }

    #[test]
    fn labels_match_status_codes() {
        assert_eq!(label_for('A', ' '), "Added");
        assert_eq!(label_for(' ', 'M'), "Modified");
        assert_eq!(label_for('D', ' '), "Deleted");
        assert_eq!(label_for('R', ' '), "Renamed");
        assert_eq!(label_for('?', '?'), "Untracked");
        assert_eq!(label_for('U', 'U'), "Conflict");
    }

    #[test]
    fn consumes_rename_original_path() {
        // Rename: "R  new" followed by the original path record.
        let raw = "## main\0R  new.ts\0old.ts\0 M other.ts\0";
        let s = parse_status(raw);
        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.staged[0].path, "new.ts");
        // The original-path record must not be mis-parsed as its own entry.
        assert_eq!(s.unstaged.len(), 1);
        assert_eq!(s.unstaged[0].path, "other.ts");
    }
}
