#!/usr/bin/env python3
"""Lint-suppression diff gate — zoc-agent-chat-rebuild R22.5, task 12.4.

Rejects a change that **adds** an `eslint-disable` line under
`apps/frontend/src/features/chat/` or `apps/agent-runtime/src/`.

Why a diff check rather than a lint rule, since ESLint already reports an
*unused* directive: the two catch different things and only one of them is the
interesting case. `reportUnusedDisableDirectives` catches a suppression that
stopped being necessary. Nothing in ESLint can catch a suppression that is
working exactly as intended and should never have been written — the rule it
silences reports nothing, by construction, which is the whole point of it. So the
gate is on the *diff*: a new suppression in these two trees is a decision that
needs a reviewer, and this makes it one.

Scoped to two trees rather than the repository, for the same reason 12.4's lint
rule is: `features/agent` is full of suppressions this rebuild is replacing and
lives until task 26.2, so a repository-wide gate would fail on code that is
already scheduled for deletion.

Usage:
    python3 scripts/lint_suppressions.py                     # vs the merge base
    python3 scripts/lint_suppressions.py --base origin/main
    python3 scripts/lint_suppressions.py --diff-file d.patch # a saved diff
    python3 scripts/lint_suppressions.py --audit             # count what exists now
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: The two trees this rebuild owns outright, and therefore holds to the rule.
GUARDED_PREFIXES = (
    "apps/frontend/src/features/chat/",
    "apps/agent-runtime/src/",
)

#: Every form of the directive, including the block-comment and per-line ones.
#: `eslint-enable` is deliberately absent: re-enabling a rule is not a
#: suppression, and matching it would reject the fix for one.
SUPPRESSION = re.compile(
    r"eslint-disable(?:-next-line|-line)?\b|@ts-(?:ignore|expect-error|nocheck)\b"
)

DEFAULT_BASE = "origin/main"


class Addition:
    """One added suppression line, with enough context to review it."""

    __slots__ = ("path", "line", "text")

    def __init__(self, path: str, line: int, text: str) -> None:
        self.path = path
        self.line = line
        self.text = text

    def __str__(self) -> str:
        return f"  {self.path}:{self.line}  {self.text.strip()}"


def is_guarded(path: str) -> bool:
    return path.startswith(GUARDED_PREFIXES)


def parse_diff(diff: str) -> list[Addition]:
    """Collect added suppression lines from a unified diff.

    The line numbers come from the hunk headers rather than being counted from
    the top of the file, because a diff does not contain the whole file — a
    reported number that was merely the offset within the hunk would send a
    reviewer to the wrong place.
    """
    found: list[Addition] = []
    path = ""
    guarded = False
    new_line = 0

    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            target = raw[4:].strip()
            # `/dev/null` is a deletion; `b/` prefixes the post-image path.
            path = "" if target == "/dev/null" else target.removeprefix("b/")
            guarded = is_guarded(path)
            continue
        if raw.startswith("@@"):
            match = re.search(r"\+(\d+)", raw)
            new_line = int(match.group(1)) if match else 0
            continue
        if not guarded:
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            body = raw[1:]
            if SUPPRESSION.search(body):
                found.append(Addition(path, new_line, body))
            new_line += 1
        elif raw.startswith(" "):
            new_line += 1
        # A `-` line consumes no new-file line number.

    return found


def git_diff(base: str, root: Path) -> str:
    """The diff against `base`, using the merge base so unrelated commits on the
    base branch do not appear as additions."""
    try:
        merge_base = subprocess.run(
            ["git", "merge-base", "HEAD", base],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except subprocess.CalledProcessError:
        # No such base — an unpushed branch, a shallow clone, a fresh repo. Fall
        # back to the working tree against HEAD, which is the useful local answer
        # and never a false pass: it reports strictly less, not more.
        merge_base = "HEAD"

    return subprocess.run(
        ["git", "diff", "--unified=0", merge_base, "--"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    ).stdout


def audit(root: Path) -> list[Addition]:
    """Every suppression currently in the guarded trees, for the `--audit` mode.

    The count is expected to be zero and is worth being able to check: the gate
    only ever sees a diff, so a suppression that predates it would otherwise be
    invisible to both.
    """
    found: list[Addition] = []
    for prefix in GUARDED_PREFIXES:
        tree = root / prefix
        if not tree.is_dir():
            continue
        for path in sorted(tree.rglob("*")):
            if path.suffix not in {".ts", ".tsx"} or not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            for number, text in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                if SUPPRESSION.search(text):
                    found.append(Addition(rel, number, text))
    return found


def report(found: list[Addition], what: str) -> int:
    if not found:
        print(f"✅ lint-suppression policy clean: no {what} under the guarded trees")
        return 0

    print(
        f"❌ {len(found)} added lint suppression(s) under a guarded tree (R22.5).\n"
        "   A new eslint-disable or @ts-ignore in features/chat or the runtime is a\n"
        "   decision that needs a reviewer, not a local workaround. Fix the reported\n"
        "   problem, or state the case in the change description and remove this line.",
        file=sys.stderr,
    )
    for addition in found:
        print(str(addition), file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--diff-file", type=Path, default=None)
    parser.add_argument(
        "--audit",
        action="store_true",
        help="report every suppression that exists now, not just added ones",
    )
    args = parser.parse_args()
    root = args.root.resolve()

    if args.audit:
        return report(audit(root), "lint suppressions")

    diff = (
        args.diff_file.read_text(encoding="utf-8") if args.diff_file else git_diff(args.base, root)
    )
    return report(parse_diff(diff), "added lint suppressions")


if __name__ == "__main__":
    sys.exit(main())
