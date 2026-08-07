#!/usr/bin/env python3
"""Traceability gate — zoc-agent-chat-rebuild R24.1, R24.2, R24.3, task 27.2.

Asserts that every source file under `apps/frontend/src/features/chat/` and
`apps/agent-runtime/src/` carries the two facts R24 asks for:

1. the literal line `Feature: zoc-agent-chat-rebuild`, in a comment or in a test
   description, which is what makes the feature machine-findable rather than
   merely mentioned; and
2. at least one identifier — `R<n>.<m>`, `task <n>.<m>`, or `Property <n>` —
   which is the *what* the first fact would otherwise leave unstated.

Why both, and why a literal string rather than a pattern over the prose: nearly
every one of these files already names the feature in its opening sentence, in a
dozen different phrasings ("— zoc-agent-chat-rebuild R13.2, task 22.8"). A gate
matching any of those would pass on a sentence that happens to contain the word
and would be unfixable by a rule anyone could state. One canonical line, placed
by convention right under the summary, is the only version of R24.3 a machine can
check — so the duplication with the summary is the point of it, not an oversight.

Scoped to the two trees this rebuild owns, for the same reason
`lint_suppressions.py` is: `features/agent` predates the convention and lives
until task 26.2.

Usage:
    python3 scripts/traceability.py
    python3 scripts/traceability.py --root /path/to/checkout
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: The two trees this rebuild owns outright, and therefore holds to R24.
GUARDED_PREFIXES = (
    "apps/frontend/src/features/chat/",
    "apps/agent-runtime/src/",
)

SOURCE_SUFFIXES = frozenset({".ts", ".tsx"})

MARKER = "Feature: zoc-agent-chat-rebuild"

#: R24.1's "requirement identifiers", R24.2's "requirement under assertion", and
#: the task ids R24.3 accepts as the repository's existing convention. `Property`
#: is here because the property tests are named by the design's numbered
#: properties, and a property number resolves to its requirements through
#: `tasks.md` — which is the citation, one indirection out.
IDENTIFIER = re.compile(r"\bR\d+\.\d+\b|\btask \d+(?:\.\d+)?\b|\bProperty \d+\b")


def guarded_files(root: Path) -> list[Path]:
    found: list[Path] = []
    for prefix in GUARDED_PREFIXES:
        tree = root / prefix
        if not tree.is_dir():
            continue
        found.extend(
            path
            for path in sorted(tree.rglob("*"))
            if path.suffix in SOURCE_SUFFIXES and path.is_file()
        )
    return found


def failures(root: Path) -> tuple[list[str], list[str]]:
    """Files with no feature marker, and files with a marker but no identifier."""
    unmarked: list[str] = []
    uncited: list[str] = []

    for path in guarded_files(root):
        rel = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8")
        if MARKER not in text:
            unmarked.append(rel)
        elif not IDENTIFIER.search(text):
            uncited.append(rel)

    return unmarked, uncited


def report(unmarked: list[str], uncited: list[str], checked: int) -> int:
    if not unmarked and not uncited:
        print(f"✅ traceability clean: {checked} files under the guarded trees cite the feature")
        return 0

    if unmarked:
        print(
            f"❌ {len(unmarked)} file(s) carry no `{MARKER}` line (R24.1, R24.3).\n"
            "   Add it to the module's header comment, under the summary:\n"
            "     * Feature: zoc-agent-chat-rebuild, task 22.8 (R13.2, R18.1).\n"
            "   In a test file, the describe title is the conventional place:\n"
            '     describe("Feature: zoc-agent-chat-rebuild, Property 44: …")',
            file=sys.stderr,
        )
        for rel in unmarked:
            print(f"  {rel}", file=sys.stderr)

    if uncited:
        print(
            f"❌ {len(uncited)} file(s) name the feature but cite no requirement, task, or\n"
            "   property identifier (R24.1, R24.2). Name what the module implements or what\n"
            "   the test asserts — `R13.2`, `task 22.8`, or `Property 44`.",
            file=sys.stderr,
        )
        for rel in uncited:
            print(f"  {rel}", file=sys.stderr)

    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    args = parser.parse_args()
    root = args.root.resolve()

    unmarked, uncited = failures(root)
    return report(unmarked, uncited, len(guarded_files(root)))


if __name__ == "__main__":
    sys.exit(main())
