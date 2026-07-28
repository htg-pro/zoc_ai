//! Source control commands (develop.md Phase 4).
//!
//! Thin, workspace-scoped wrappers over the `git` CLI. We shell out rather than
//! link libgit2 to keep the dependency surface small and behavior identical to
//! the user's own git. Every command runs with `current_dir` = the active
//! workspace root, and any file paths the renderer supplies are validated with
//! `ensure_within_workspace` before they reach git.
//!
//! ## Repository guard (R14.1–R14.5)
//!
//! Every `#[tauri::command]` routes through [`git_guarded`], whose first git
//! invocation is always `rev-parse --is-inside-work-tree`. When the workspace
//! is not a repository no further subcommand runs and the caller receives a
//! typed [`GitError::NotARepository`]; a non-zero subcommand yields a typed
//! [`GitError::CommandFailed`] carrying the subcommand name and captured
//! output. The guard is generic over a [`GitRunner`] so its invocation order
//! and count are property-tested with a recording runner and no real repo.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use serde::Serialize;

use crate::workspace::{ensure_within_workspace, WorkspaceState};

/// Typed git failure (R14.2, R14.4). Serialized as a tagged object so the
/// frontend can switch on `kind` and route `command-failed.output` to the Logs
/// panel without ever rendering raw stderr in the chat (R14.5).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GitError {
    /// R14.2 — the workspace is not inside a git repository; no subcommand ran.
    NotARepository { root: String },
    /// No workspace root is configured, so no operation is possible.
    NoWorkspace,
    /// R14.4 — a subcommand exited non-zero; carries the subcommand and stderr.
    CommandFailed { subcommand: String, output: String },
    /// The `git` binary could not be executed at all (not on PATH).
    GitUnavailable { detail: String },
}

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

/// Abstraction over invoking `git`, so the guard's invocation order and count
/// can be property-tested with a recording runner and no real repository.
trait GitRunner {
    /// Run `git <args>` in `root`. Returns stdout on success, a typed error on
    /// failure. A non-zero exit is reported as [`GitError::CommandFailed`];
    /// the guard translates a failing `rev-parse` into `NotARepository`.
    fn run(&self, root: &Path, args: &[&str]) -> Result<String, GitError>;
}

/// The production runner: shells out to the user's own `git`.
struct SystemGitRunner;

impl GitRunner for SystemGitRunner {
    fn run(&self, root: &Path, args: &[&str]) -> Result<String, GitError> {
        let out = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .map_err(|e| GitError::GitUnavailable {
                detail: format!("git is not available on PATH: {e}"),
            })?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let subcommand = args.first().copied().unwrap_or("").to_string();
            let output = if stderr.is_empty() {
                format!("git {subcommand} failed")
            } else {
                stderr
            };
            Err(GitError::CommandFailed { subcommand, output })
        }
    }
}

/// R14.1 — the repository check, always the first git invocation of a guarded
/// operation. A failing or non-`true` `rev-parse` becomes `NotARepository`
/// (R14.2); a runner that could not execute git at all propagates as
/// `GitUnavailable`.
fn ensure_repository<R: GitRunner>(runner: &R, root: &Path) -> Result<(), GitError> {
    match runner.run(root, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(out) if out.trim() == "true" => Ok(()),
        Ok(_) => Err(GitError::NotARepository {
            root: root.display().to_string(),
        }),
        Err(GitError::CommandFailed { .. }) => Err(GitError::NotARepository {
            root: root.display().to_string(),
        }),
        Err(other) => Err(other),
    }
}

/// The guarded runner: refuses without a workspace, checks the repository
/// first, then runs the requested subcommand. Generic over the runner so tests
/// can assert order and count.
fn git_guarded_with<R: GitRunner>(
    runner: &R,
    root: Option<PathBuf>,
    args: &[&str],
) -> Result<String, GitError> {
    let root = root.ok_or(GitError::NoWorkspace)?;
    ensure_repository(runner, &root)?;
    runner.run(&root, args)
}

/// R14.1 — every git operation goes through here, and the repository check is
/// always the first invocation. Replaces the old ad-hoc `rev-parse` check in
/// `git_status` so no command can bypass the guard.
fn git_guarded(workspace: &WorkspaceState, args: &[&str]) -> Result<String, GitError> {
    git_guarded_with(&SystemGitRunner, workspace.get(), args)
}

/// Validate each renderer-supplied path and return absolute strings safe to
/// pass to git after `--`. A path escaping the workspace is refused before any
/// git subcommand runs; the confinement message is developer-facing (routed to
/// Logs via `CommandFailed.output`, never rendered in chat — R14.5).
fn safe_paths(
    workspace: &WorkspaceState,
    subcommand: &str,
    paths: &[String],
) -> Result<Vec<String>, GitError> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        let resolved = ensure_within_workspace(workspace, Path::new(p)).map_err(|output| {
            GitError::CommandFailed {
                subcommand: subcommand.to_string(),
                output,
            }
        })?;
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
    matches!((x, y), ('D', 'D') | ('A', 'A') | ('U', _) | (_, 'U'))
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
/// conflicts. Routes through the guard, so a non-repository workspace returns a
/// typed [`GitError::NotARepository`] (R14.2, R14.3) rather than a synthetic
/// `is_repo: false` — the surface renders the non-repo state from the typed
/// error and hides git-dependent controls.
#[tauri::command]
pub fn git_status(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    _root: Option<String>,
) -> Result<GitStatus, GitError> {
    let raw = git_guarded(&workspace, &["status", "--porcelain=v1", "--branch", "-z"])?;
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
) -> Result<String, GitError> {
    let abs = safe_paths(&workspace, "diff", std::slice::from_ref(&path))?;
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&abs[0]);
    git_guarded(&workspace, &args)
}

#[tauri::command]
pub fn git_stage(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    paths: Vec<String>,
) -> Result<(), GitError> {
    let abs = safe_paths(&workspace, "add", &paths)?;
    let mut args = vec!["add", "--"];
    args.extend(abs.iter().map(String::as_str));
    git_guarded(&workspace, &args).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    paths: Vec<String>,
) -> Result<(), GitError> {
    let abs = safe_paths(&workspace, "reset", &paths)?;
    let mut args = vec!["reset", "-q", "HEAD", "--"];
    args.extend(abs.iter().map(String::as_str));
    git_guarded(&workspace, &args).map(|_| ())
}

/// Discard worktree changes for tracked files (destructive — the UI confirms).
#[tauri::command]
pub fn git_discard(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    paths: Vec<String>,
) -> Result<(), GitError> {
    let abs = safe_paths(&workspace, "checkout", &paths)?;
    let mut args = vec!["checkout", "--"];
    args.extend(abs.iter().map(String::as_str));
    git_guarded(&workspace, &args).map(|_| ())
}

#[tauri::command]
pub fn git_commit(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    message: String,
) -> Result<String, GitError> {
    if message.trim().is_empty() {
        return Err(GitError::CommandFailed {
            subcommand: "commit".to_string(),
            output: "commit message is required".to_string(),
        });
    }
    git_guarded(&workspace, &["commit", "-m", &message])?;
    Ok(git_guarded(&workspace, &["rev-parse", "HEAD"])?
        .trim()
        .to_string())
}

#[tauri::command]
pub fn git_checkpoint_commit(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    message: String,
) -> Result<String, GitError> {
    if message.trim().is_empty() {
        return Err(GitError::CommandFailed {
            subcommand: "commit".to_string(),
            output: "commit message is required".to_string(),
        });
    }
    git_guarded(&workspace, &["add", "-A"])?;
    git_guarded(&workspace, &["commit", "--allow-empty", "-m", &message])?;
    Ok(git_guarded(&workspace, &["rev-parse", "HEAD"])?
        .trim()
        .to_string())
}

#[tauri::command]
pub fn git_branches(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
) -> Result<Vec<GitBranch>, GitError> {
    let raw = git_guarded(
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
) -> Result<(), GitError> {
    git_guarded(&workspace, &["checkout", &branch]).map(|_| ())
}

#[tauri::command]
pub fn git_create_branch(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    name: String,
) -> Result<(), GitError> {
    if name.trim().is_empty() {
        return Err(GitError::CommandFailed {
            subcommand: "checkout".to_string(),
            output: "branch name is required".to_string(),
        });
    }
    git_guarded(&workspace, &["checkout", "-b", name.trim()]).map(|_| ())
}

#[tauri::command]
pub fn git_pull(workspace: tauri::State<'_, Arc<WorkspaceState>>) -> Result<String, GitError> {
    git_guarded(&workspace, &["pull", "--ff-only"])
}

#[tauri::command]
pub fn git_push(workspace: tauri::State<'_, Arc<WorkspaceState>>) -> Result<String, GitError> {
    // If the branch has no upstream, set it on first push.
    match git_guarded(&workspace, &["push"]) {
        Ok(o) => Ok(o),
        Err(GitError::CommandFailed { output, .. })
            if output.contains("no upstream") || output.contains("--set-upstream") =>
        {
            let branch = git_guarded(&workspace, &["rev-parse", "--abbrev-ref", "HEAD"])?
                .trim()
                .to_string();
            git_guarded(&workspace, &["push", "-u", "origin", &branch])
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn git_log(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    limit: Option<usize>,
) -> Result<Vec<GitCommit>, GitError> {
    let n = format!("-n{}", limit.unwrap_or(50));
    // Field sep \x1f, record sep \x1e.
    let raw = git_guarded(
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
) -> Result<Vec<String>, GitError> {
    let raw = git_guarded(
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
) -> Result<Vec<BlameLine>, GitError> {
    let abs = safe_paths(&workspace, "blame", std::slice::from_ref(&path))?;
    let raw = git_guarded(&workspace, &["blame", "--line-porcelain", "--", &abs[0]])?;
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
        assert_eq!(
            s.staged.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["added.ts", "both.ts"]
        );
        // worktree.ts + both.ts (worktree side)
        assert_eq!(
            s.unstaged
                .iter()
                .map(|e| e.path.as_str())
                .collect::<Vec<_>>(),
            vec!["worktree.ts", "both.ts"]
        );
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

#[cfg(test)]
mod guard_tests {
    use super::*;
    use proptest::prelude::*;
    use std::cell::RefCell;

    const REV_PARSE: [&str; 2] = ["rev-parse", "--is-inside-work-tree"];

    /// How the recording runner answers `rev-parse --is-inside-work-tree`.
    #[derive(Clone, Copy, Debug)]
    enum RepoAnswer {
        /// Inside a work tree — `rev-parse` prints "true".
        Yes,
        /// `rev-parse` fails as it does outside a repository.
        NotRepo,
        /// `git` cannot be executed at all.
        Unavailable,
    }

    /// A recording [`GitRunner`]: records every invocation's args and returns
    /// programmed responses, so the guard's order and count are asserted with
    /// no real repository (Property 29).
    struct RecordingRunner {
        calls: RefCell<Vec<Vec<String>>>,
        repo: RepoAnswer,
        sub_result: Result<String, GitError>,
    }

    impl RecordingRunner {
        fn new(repo: RepoAnswer, sub_result: Result<String, GitError>) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                repo,
                sub_result,
            }
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.borrow().clone()
        }
    }

    impl GitRunner for RecordingRunner {
        fn run(&self, _root: &Path, args: &[&str]) -> Result<String, GitError> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|s| s.to_string()).collect());
            if args == REV_PARSE {
                return match self.repo {
                    RepoAnswer::Yes => Ok("true\n".to_string()),
                    RepoAnswer::NotRepo => Err(GitError::CommandFailed {
                        subcommand: "rev-parse".to_string(),
                        output: "fatal: not a git repository".to_string(),
                    }),
                    RepoAnswer::Unavailable => Err(GitError::GitUnavailable {
                        detail: "git is not available on PATH".to_string(),
                    }),
                };
            }
            self.sub_result.clone()
        }
    }

    #[test]
    fn no_workspace_invokes_no_git() {
        let runner = RecordingRunner::new(RepoAnswer::Yes, Ok(String::new()));
        let result = git_guarded_with(&runner, None, &["status"]);
        assert_eq!(result, Err(GitError::NoWorkspace));
        assert!(
            runner.calls().is_empty(),
            "no git subcommand may run without a workspace"
        );
    }

    #[test]
    fn not_a_repository_stops_after_the_check() {
        let runner = RecordingRunner::new(RepoAnswer::NotRepo, Ok("unreachable".to_string()));
        let result = git_guarded_with(&runner, Some(PathBuf::from("/tmp/x")), &["status"]);
        assert_eq!(
            result,
            Err(GitError::NotARepository {
                root: "/tmp/x".to_string()
            })
        );
        // Exactly one invocation: the repository check, and nothing after it.
        assert_eq!(
            runner.calls(),
            vec![vec!["rev-parse", "--is-inside-work-tree"]]
        );
    }

    #[test]
    fn git_unavailable_propagates_from_the_check() {
        let runner = RecordingRunner::new(RepoAnswer::Unavailable, Ok(String::new()));
        let result = git_guarded_with(&runner, Some(PathBuf::from("/tmp/x")), &["status"]);
        assert!(matches!(result, Err(GitError::GitUnavailable { .. })));
        assert_eq!(runner.calls().len(), 1);
    }

    #[test]
    fn subcommand_failure_carries_name_and_output() {
        let runner = RecordingRunner::new(
            RepoAnswer::Yes,
            Err(GitError::CommandFailed {
                subcommand: "push".to_string(),
                output: "error: failed to push some refs".to_string(),
            }),
        );
        let result = git_guarded_with(&runner, Some(PathBuf::from("/repo")), &["push"]);
        assert_eq!(
            result,
            Err(GitError::CommandFailed {
                subcommand: "push".to_string(),
                output: "error: failed to push some refs".to_string(),
            })
        );
        assert_eq!(
            runner.calls(),
            vec![vec!["rev-parse", "--is-inside-work-tree"], vec!["push"]]
        );
    }

    #[test]
    fn git_error_serializes_as_kebab_tagged_object() {
        let json = serde_json::to_value(GitError::NotARepository {
            root: "/r".to_string(),
        })
        .unwrap();
        assert_eq!(json["kind"], "not-a-repository");
        assert_eq!(json["root"], "/r");

        let json = serde_json::to_value(GitError::CommandFailed {
            subcommand: "diff".to_string(),
            output: "boom".to_string(),
        })
        .unwrap();
        assert_eq!(json["kind"], "command-failed");
        assert_eq!(json["subcommand"], "diff");
        assert_eq!(json["output"], "boom");

        let json = serde_json::to_value(GitError::NoWorkspace).unwrap();
        assert_eq!(json["kind"], "no-workspace");
    }

    fn any_subcommand() -> impl Strategy<Value = String> {
        prop::sample::select(vec![
            "status", "diff", "add", "reset", "checkout", "commit", "log", "push", "pull",
            "branch", "blame",
        ])
        .prop_map(|s| s.to_string())
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        /// Feature: zoc-ai-agent-chat-overhaul, Property 29: Git operations are
        /// guarded and reported as typed results.
        ///
        /// The repository check is the first git invocation; a non-repository
        /// workspace runs no further subcommand and yields NotARepository; a
        /// failing subcommand yields CommandFailed carrying its name and output;
        /// no raw output escapes the typed result.
        #[test]
        fn prop_guard_order_and_typed_results(
            subcommand in any_subcommand(),
            is_repo in any::<bool>(),
            sub_fails in any::<bool>(),
            stderr in "[^\u{0}]{0,64}",
        ) {
            let sub_result: Result<String, GitError> = if sub_fails {
                Err(GitError::CommandFailed {
                    subcommand: subcommand.clone(),
                    output: stderr.clone(),
                })
            } else {
                Ok("ok-stdout".to_string())
            };
            let repo = if is_repo { RepoAnswer::Yes } else { RepoAnswer::NotRepo };
            let runner = RecordingRunner::new(repo, sub_result);
            let sub = subcommand.clone();
            let result = git_guarded_with(&runner, Some(PathBuf::from("/repo")), &[sub.as_str()]);
            let calls = runner.calls();

            // R14.1: the repository check is always the first git invocation.
            prop_assert_eq!(&calls[0], &vec!["rev-parse".to_string(), "--is-inside-work-tree".to_string()]);

            if !is_repo {
                // R14.2: no further subcommand runs; typed not-a-repository.
                prop_assert_eq!(calls.len(), 1);
                prop_assert_eq!(result, Err(GitError::NotARepository { root: "/repo".to_string() }));
            } else {
                // The subcommand runs exactly once, after the check.
                prop_assert_eq!(calls.len(), 2);
                prop_assert_eq!(&calls[1], &vec![subcommand.clone()]);
                if sub_fails {
                    // R14.4: typed error carrying the subcommand and its output.
                    prop_assert_eq!(
                        result,
                        Err(GitError::CommandFailed { subcommand: subcommand.clone(), output: stderr.clone() })
                    );
                } else {
                    prop_assert_eq!(result, Ok("ok-stdout".to_string()));
                }
            }
        }
    }
}
