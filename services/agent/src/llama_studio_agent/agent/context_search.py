"""Workspace context search for the `@` picker — files and folders.

Pure, dependency-light ranking over the workspace file list (reusing
``iter_files``). Symbols are layered on top at the route level via the code
index; this module owns the deterministic, testable file/folder ranking.
"""

from __future__ import annotations

from pathlib import Path

from .workspace_diff import iter_files


def fuzzy_score(query: str, text: str) -> float | None:
    """Subsequence fuzzy score in [0, 1], or None when `query` isn't a
    subsequence of `text` (case-insensitive). Higher is better: contiguous and
    early matches (esp. on the basename) score higher."""
    if not query:
        return 0.5
    q = query.lower()
    t = text.lower()
    # Fast path: substring match scores high, boosted when it hits the basename.
    idx = t.find(q)
    if idx != -1:
        base = t.rsplit("/", 1)[-1]
        in_base = q in base
        # Earlier + basename hits rank higher.
        return 0.7 + (0.2 if in_base else 0.0) + 0.1 * (1.0 - min(idx, 40) / 40.0)
    # Subsequence match.
    ti = 0
    matched = 0
    for ch in q:
        found = t.find(ch, ti)
        if found == -1:
            return None
        ti = found + 1
        matched += 1
    return 0.3 * (matched / len(t)) if t else None


def search_files(workspace_root: str, query: str, limit: int = 25) -> list[dict[str, object]]:
    """Return ranked file + folder candidates matching `query`. Each item is a
    dict: {kind, label, path, detail}. Folders are derived from file paths."""
    root = Path(workspace_root)
    if not root.is_dir():
        return []
    rels = [str(p) for p in iter_files(root)]

    scored: list[tuple[float, dict[str, object]]] = []
    folders_seen: set[str] = set()

    for rel in rels:
        fscore = fuzzy_score(query, rel)
        if fscore is not None:
            scored.append(
                (
                    fscore,
                    {
                        "kind": "file",
                        "label": rel.rsplit("/", 1)[-1],
                        "path": rel,
                        "detail": rel,
                    },
                )
            )
        # Derive folder candidates from each path segment.
        parts = rel.split("/")[:-1]
        acc = ""
        for seg in parts:
            acc = f"{acc}/{seg}" if acc else seg
            if acc in folders_seen:
                continue
            folders_seen.add(acc)
            dscore = fuzzy_score(query, acc)
            if dscore is not None:
                scored.append(
                    (
                        # Slightly deprioritise folders vs files at equal score.
                        dscore - 0.01,
                        {"kind": "folder", "label": seg, "path": acc, "detail": acc},
                    )
                )

    scored.sort(key=lambda x: (-x[0], str(x[1]["path"])))
    return [item for _, item in scored[:limit]]


__all__ = ["fuzzy_score", "search_files"]
