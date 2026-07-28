#!/usr/bin/env python3
"""Dependency-policy gate — zoc-agent-chat-rebuild R5.4, R22.5.

Refuses the build when any workspace manifest *or* the pnpm lockfile resolves a
banned agent framework. Zoc AI owns its tool loop on the AI SDK; LangChain,
LangGraph, and Mastra were evaluated and rejected in the design, and this script
is what stops that decision from being quietly reversed by a `pnpm add`.

**The lockfile is scanned, not just the manifests.** A transitive pull ships the
bytes just as surely as a direct dependency does, and a direct dependency is the
case a reviewer would already have caught. The lockfile is where the interesting
failure hides.

Usage:
    python3 scripts/deps_policy.py                    # scan the real tree
    python3 scripts/deps_policy.py --root /tmp/fake   # scan a synthetic tree
    python3 scripts/deps_policy.py --lockfile a.yaml  # scan one lockfile
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: The banned set, as the requirement words it. Anchored at the start so
#: `langchain-text-splitters` is caught and `my-langchain-notes` is not a false
#: positive on a package that merely mentions the name.
BANNED_PATTERN = re.compile(r"^(langchain|@langchain/|@mastra/|mastra$)")

#: Directories never worth walking. `node_modules` is deliberately excluded:
#: an installed tree is a build artefact, and the lockfile is the authority on
#: what may be installed.
SKIP_DIRS = {
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".hypothesis",
}

DEPENDENCY_SECTIONS = (
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "resolutions",
    "overrides",
)


class Violation:
    __slots__ = ("location", "package", "source")

    def __init__(self, source: str, location: str, package: str) -> None:
        self.source = source
        self.location = location
        self.package = package

    def __str__(self) -> str:
        return f"  {self.source}: {self.location} → {self.package}"

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Violation) and (
            self.source,
            self.location,
            self.package,
        ) == (other.source, other.location, other.package)

    def __hash__(self) -> int:
        return hash((self.source, self.location, self.package))


def is_banned(name: str) -> bool:
    return BANNED_PATTERN.match(name) is not None


def iter_manifests(root: Path):
    """Yield every `package.json` in the workspace, skipping build artefacts."""
    for path in sorted(root.rglob("package.json")):
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        yield path


def scan_manifest(path: Path, root: Path) -> list[Violation]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"⚠️  could not read {path}: {exc}", file=sys.stderr)
        return []
    if not isinstance(data, dict):
        return []

    rel = path.relative_to(root).as_posix()
    found: list[Violation] = []
    for section in DEPENDENCY_SECTIONS:
        block = data.get(section)
        if not isinstance(block, dict):
            continue
        for name in block:
            if is_banned(str(name)):
                found.append(Violation("manifest", f"{rel} [{section}]", str(name)))
    return found


#: pnpm lockfile v9 keys packages as `'<name>@<version>'` at column 2 under
#: `packages:` / `snapshots:`, and dependency edges as `'<name>': <spec>` at
#: deeper indentation. Both forms are matched: a name that appears only as an
#: edge is still a name the install would fetch.
_LOCK_ENTRY = re.compile(r"^\s{2,}'?((?:@[^/'@\s]+/)?[^'@\s:]+)@")
_LOCK_EDGE = re.compile(r"^\s{4,}'?((?:@[^/'@\s]+/)?[^'@\s:]+)'?:\s")


def scan_lockfile(path: Path) -> list[Violation]:
    """Scan a pnpm lockfile textually.

    Deliberately not parsed as YAML: `pnpm-lock.yaml` is ~350 kB here and the
    gate must run in the Build_Gate on every check, so a line scan with two
    anchored regexes is both faster and free of a PyYAML dependency in a script
    whose entire job is to police dependencies.
    """
    if not path.exists():
        return []

    found: set[Violation] = set()
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        for pattern in (_LOCK_ENTRY, _LOCK_EDGE):
            match = pattern.match(line)
            if match and is_banned(match.group(1)):
                found.add(Violation("lockfile", f"{path.name}:{lineno}", match.group(1)))
    return sorted(found, key=lambda v: (v.location, v.package))


def run(root: Path, lockfile: Path | None) -> int:
    violations: list[Violation] = []
    for manifest in iter_manifests(root):
        violations.extend(scan_manifest(manifest, root))

    lock = lockfile if lockfile is not None else root / "pnpm-lock.yaml"
    violations.extend(scan_lockfile(lock))

    if violations:
        print("❌ dependency policy violated (R5.4)", file=sys.stderr)
        print(
            "   Zoc AI owns its tool loop on the AI SDK. LangChain/LangGraph and\n"
            "   Mastra were evaluated and rejected; see design.md 'Library ownership'.",
            file=sys.stderr,
        )
        for violation in violations:
            print(str(violation), file=sys.stderr)
        return 1

    print("✅ dependency policy clean: no banned agent framework in manifests or lockfile")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--lockfile", type=Path, default=None)
    args = parser.parse_args()
    return run(args.root.resolve(), args.lockfile.resolve() if args.lockfile else None)


if __name__ == "__main__":
    sys.exit(main())
