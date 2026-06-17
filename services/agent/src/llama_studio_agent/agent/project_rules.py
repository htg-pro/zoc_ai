"""Project rules — per-project conventions the agent must follow.

Zoc's equivalent of `.cursorrules` / `AGENTS.md`: a project can declare coding
conventions, architectural constraints, and do/don't guidance that get injected
into the agent's system prompt so its output matches the project's standards.

Sources, in priority order (first non-empty wins as the "primary", but `.zoc`
files are always preferred):
  1. `.zoc/rules.md`                     — single rules file
  2. `.zoc/rules/*.md`                   — multiple rule files (sorted)
  3. `AGENTS.md` / `.cursorrules` (root) — legacy compatibility, only if no
     `.zoc` rules exist
"""

from __future__ import annotations

from pathlib import Path

RULES_FILE = ".zoc/rules.md"
RULES_DIR = ".zoc/rules"
LEGACY_FILES = ("AGENTS.md", ".cursorrules")

# Keep the injected block bounded so a huge rules file can't crowd out the
# actual conversation / tool context.
MAX_RULES_BYTES = 16_000



def _read(path: Path) -> str | None:
    try:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    except OSError:
        return None
    return None


def collect_rule_sources(workspace_root: str) -> list[tuple[str, str]]:
    """Return `(label, content)` for each rules source found, in inject order.
    Pure filesystem read; never raises."""
    root = Path(workspace_root)
    sources: list[tuple[str, str]] = []

    primary = _read(root / RULES_FILE)
    if primary and primary.strip():
        sources.append((RULES_FILE, primary.strip()))

    rules_dir = root / RULES_DIR
    try:
        dir_files = sorted(rules_dir.glob("*.md")) if rules_dir.is_dir() else []
    except OSError:
        dir_files = []
    for f in dir_files:
        content = _read(f)
        if content and content.strip():
            sources.append((f"{RULES_DIR}/{f.name}", content.strip()))

    # Legacy fallback only when no .zoc rules were found.
    if not sources:
        for name in LEGACY_FILES:
            content = _read(root / name)
            if content and content.strip():
                sources.append((name, content.strip()))
                break

    return sources


def load_project_rules(workspace_root: str) -> str:
    """Build the system-message block of project rules, or "" when none exist.
    The combined content is truncated to ``MAX_RULES_BYTES``."""
    sources = collect_rule_sources(workspace_root)
    if not sources:
        return ""

    blocks: list[str] = []
    if len(sources) == 1:
        blocks.append(sources[0][1])
    else:
        for label, content in sources:
            blocks.append(f"### {label}\n{content}")
    body = "\n\n".join(blocks)
    if len(body) > MAX_RULES_BYTES:
        body = body[:MAX_RULES_BYTES] + "\n…(project rules truncated)"

    return (
        "Project rules — these are authoritative conventions for THIS workspace. "
        "Follow them unless the user explicitly overrides them:\n\n" + body
    )


__all__ = ["MAX_RULES_BYTES", "collect_rule_sources", "load_project_rules"]
