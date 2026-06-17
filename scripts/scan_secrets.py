#!/usr/bin/env python3
"""Dependency-free secret scanner.

Scans the working tree (default) or the full git history (``--history``) for
common credential patterns. Exits non-zero when a likely secret is found so it
can gate CI or a pre-commit hook without needing an external binary.

Usage:
    python3 scripts/scan_secrets.py            # scan tracked working-tree files
    python3 scripts/scan_secrets.py --history  # scan every blob in git history
    python3 scripts/scan_secrets.py path1 ...  # scan specific files (pre-commit)
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# (name, compiled regex). Patterns target provider key *formats* so they catch
# real keys without flagging ordinary prose.
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("Groq API key", re.compile(r"gsk_[A-Za-z0-9]{40,}")),
    ("OpenAI key", re.compile(r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("Anthropic key", re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}")),
    ("xAI key", re.compile(r"xai-[A-Za-z0-9]{20,}")),
    ("Google API key", re.compile(r"AIza[A-Za-z0-9_-]{35}")),
    ("GitLab PAT", re.compile(r"glpat-[A-Za-z0-9._-]{20,}")),
    ("GitHub PAT", re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}")),
    ("GitHub fine-grained PAT", re.compile(r"github_pat_[A-Za-z0-9_]{60,}")),
    ("AWS access key id", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("Slack token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("Private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
]

# Substrings that mark an intentional, non-secret placeholder.
ALLOWLIST = (
    "REDACTED",
    "ROTATE_ME",
    "gsk_test",
    "sk-test",
    "your-",
    "<your",
    "example",
    "EXAMPLE",
    "xxxx",
    "XXXX",
    "placeholder",
)

# Files/dirs that never contain real secrets and produce noise.
SKIP_DIRS = {
    ".git", "node_modules", ".venv", "target", "dist", ".mypy_cache",
    ".ruff_cache", ".pytest_cache", "__pycache__", ".uv-cache",
}
# This scanner defines the patterns themselves, so skip it.
SKIP_FILES = {"scripts/scan_secrets.py"}


def _is_allowlisted(line: str) -> bool:
    return any(token in line for token in ALLOWLIST)


def _scan_text(label: str, text: str) -> list[str]:
    findings: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if _is_allowlisted(line):
            continue
        for name, pat in PATTERNS:
            if pat.search(line):
                snippet = line.strip()[:120]
                findings.append(f"{label}:{lineno}: [{name}] {snippet}")
    return findings


def _tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout
    return [f for f in out.splitlines() if f]


def scan_working_tree(paths: list[str]) -> list[str]:
    files = paths or _tracked_files()
    findings: list[str] = []
    for f in files:
        if f in SKIP_FILES or any(part in SKIP_DIRS for part in Path(f).parts):
            continue
        p = Path(f)
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable — skip
        findings.extend(_scan_text(f, text))
    return findings


def scan_history() -> list[str]:
    """Scan every blob ever committed. Slower, but catches secrets that were
    removed from the working tree yet remain recoverable from history."""
    revs = subprocess.run(
        ["git", "rev-list", "--all"], capture_output=True, text=True, check=True
    ).stdout.split()
    findings: list[str] = []
    seen_blobs: set[str] = set()
    for rev in revs:
        listing = subprocess.run(
            ["git", "ls-tree", "-r", rev], capture_output=True, text=True, check=True
        ).stdout
        for entry in listing.splitlines():
            # mode type sha\tpath
            meta, _, path = entry.partition("\t")
            parts = meta.split()
            if len(parts) < 3:
                continue
            sha = parts[2]
            if sha in seen_blobs:
                continue
            seen_blobs.add(sha)
            if any(part in SKIP_DIRS for part in Path(path).parts):
                continue
            blob = subprocess.run(
                ["git", "cat-file", "-p", sha], capture_output=True, check=True
            ).stdout
            try:
                text = blob.decode("utf-8")
            except UnicodeDecodeError:
                continue
            findings.extend(_scan_text(f"{rev[:9]}:{path}", text))
    return findings


def main(argv: list[str]) -> int:
    history = "--history" in argv
    paths = [a for a in argv if not a.startswith("--")]
    findings = scan_history() if history else scan_working_tree(paths)
    scope = "git history" if history else "working tree"
    if findings:
        print(f"✖ Potential secrets found in {scope}:\n", file=sys.stderr)
        for f in sorted(set(findings)):
            print(f"  {f}", file=sys.stderr)
        print(
            f"\n{len(set(findings))} finding(s). Rotate the credential and remove it. "
            "If it's a false positive, add a placeholder token from the allowlist.",
            file=sys.stderr,
        )
        return 1
    print(f"✓ No secrets detected in {scope}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
