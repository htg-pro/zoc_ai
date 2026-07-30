"""Project-rules discovery (R30.1, R30.2).

Finds the rule files a workspace declares under the three conventions Zoc
supports, reads them, and returns them as ``RuleDocument``\\ s for the
Agent_Runtime's system-instruction assembler to order and merge (R30.3).

**Discovery lives here, not in the runtime.** R6.3's capability table keeps the
``rules`` capability on Workspace_Services because discovery and file reads
belong where the filesystem is; the runtime does not walk the tree. That split
is also why this module returns *per-source* contents rather than one merged
string: ordering is the runtime's job, and a pre-merged blob cannot be
reordered.

The three conventions, and why each is matched the way it is:

* ``.zoc/rules/**/*.{md,mdc}`` — Zoc's own. Recursive, because a rule placed in
  a subdirectory is how a project scopes a rule to a subtree.
* ``.cursor/rules/**/*.{md,mdc}`` — Cursor compatibility, same shape.
* ``AGENTS.md`` at any depth — the cross-tool convention, which is a *file* name
  rather than a directory, so it is matched separately.

Nested variants (``src/.zoc/rules/x.md``) are found by walking, not by a fixed
prefix, because the whole point of a nested rule is that it lives beside the
code it governs.

Every failure is contained. A file that cannot be read or decoded is returned
with ``content=None`` and a reason in ``error`` rather than raising, matching
``compile_steering``'s R8.7 behaviour: one unreadable file in a directory nobody
is working in must not stop a Run from starting.
"""

from __future__ import annotations

import os
from pathlib import Path

from shared_schema.models import ProjectRulesInfo, RuleDocument

__all__ = [
    "AGENTS_FILENAME",
    "MAX_RULE_BYTES",
    "MAX_RULE_FILES",
    "RULE_DIRECTORIES",
    "RULE_SUFFIXES",
    "SKIPPED_DIRECTORIES",
    "discover_project_rules",
    "discover_rule_documents",
]

#: Directory markers, relative to any directory in the tree.
RULE_DIRECTORIES: tuple[tuple[str, str], ...] = ((".zoc", "rules"), (".cursor", "rules"))

#: The cross-tool convention, matched as a filename at any depth.
AGENTS_FILENAME = "AGENTS.md"

#: Extensions treated as rule text. ``.mdc`` is Cursor's own.
RULE_SUFFIXES: frozenset[str] = frozenset({".md", ".mdc"})

#: Directories never descended into. A rules file inside ``node_modules`` is a
#: dependency's rules, not this project's, and walking it is the difference
#: between a discovery that takes milliseconds and one that takes seconds.
SKIPPED_DIRECTORIES: frozenset[str] = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        "target",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
    }
)

#: Per-file read ceiling. The runtime truncates again at its own budget; this
#: one exists so a multi-megabyte file is never read into memory at all.
MAX_RULE_BYTES = 256 * 1024

#: Ceiling on discovered files, so a pathological tree cannot produce an
#: unbounded response. Sources are sorted before truncation, so the cut is
#: deterministic rather than filesystem-order dependent.
MAX_RULE_FILES = 200


def _is_rule_file(path: Path) -> bool:
    return path.suffix.lower() in RULE_SUFFIXES


def _read(path: Path, root: Path) -> RuleDocument:
    """Read one rule file, converting every failure into a reported document."""
    rel = path.relative_to(root).as_posix()
    try:
        size = path.stat().st_size
    except OSError as exc:
        return RuleDocument(
            path=rel, content=None, error=f"Could not stat the file: {exc.strerror or exc}"
        )

    if size > MAX_RULE_BYTES:
        return RuleDocument(
            path=rel,
            content=None,
            error=f"The file is larger than the {MAX_RULE_BYTES}-byte rule limit.",
        )
    try:
        return RuleDocument(path=rel, content=path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        return RuleDocument(path=rel, content=None, error="The file is not valid UTF-8 text.")
    except OSError as exc:
        return RuleDocument(
            path=rel, content=None, error=f"Could not read the file: {exc.strerror or exc}"
        )


def discover_rule_documents(workspace_root: Path | str) -> list[RuleDocument]:
    """Discover and read every rule source under ``workspace_root``.

    Returns documents sorted by workspace-relative path. The sort is *not* the
    precedence order — that is the runtime's ``classifyRuleSources``, which
    orders by convention rather than alphabetically. Sorting here only makes the
    result deterministic so two calls against an unchanged tree agree, and so
    the ``MAX_RULE_FILES`` cut is stable.
    """
    root = Path(workspace_root)
    if not root.is_dir():
        return []

    found: set[Path] = set()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        # Prune in place so `os.walk` does not descend. Rebinding `dirnames`
        # would not prune; mutating the list is the documented contract.
        dirnames[:] = sorted(d for d in dirnames if d not in SKIPPED_DIRECTORIES)
        here = Path(dirpath)

        if AGENTS_FILENAME in filenames:
            found.add(here / AGENTS_FILENAME)

        for marker, sub in RULE_DIRECTORIES:
            rules_dir = here / marker / sub
            if not rules_dir.is_dir():
                continue
            for candidate in rules_dir.rglob("*"):
                if candidate.is_file() and _is_rule_file(candidate):
                    found.add(candidate)

    ordered = sorted(found, key=lambda p: p.relative_to(root).as_posix())
    return [_read(path, root) for path in ordered[:MAX_RULE_FILES]]


def discover_project_rules(workspace_root: Path | str) -> ProjectRulesInfo:
    """Discover rules and pack them into the wire model.

    ``sources`` and ``rules`` keep serving the existing renderer Rules display;
    ``documents`` is what the Agent_Runtime reads. ``active`` is true only when
    at least one source produced usable text, so a workspace whose only rule
    file is unreadable reports inactive rather than claiming rules apply.
    """
    documents = discover_rule_documents(workspace_root)
    usable = [d for d in documents if d.content is not None and d.content.strip()]
    return ProjectRulesInfo(
        active=bool(usable),
        sources=[d.path for d in usable],
        rules="\n\n".join(d.content or "" for d in usable),
        documents=documents,
    )
