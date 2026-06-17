"""Workspace checkpoints — one-click undo of an agent run's applied changes.

When an isolated run's changes are *applied* to the real workspace, we first
snapshot the pre-change state of exactly the files that are about to change.
That snapshot ("checkpoint") is persisted on disk, keyed by run id, and
survives the isolated-run cleanup — so the user can later **Restore** to undo
the run, the way Cursor / Claude Code "restore checkpoint" works.

Restore semantics (full inverse of an apply):
  * modified file  → its pre-change bytes are written back
  * file created by the run (absent before) → removed
  * file deleted by the run (present before) → recreated from the snapshot
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

_MANIFEST = "manifest.json"

# Cap restorable checkpoints per session so the temp store can't grow without
# bound. On each new checkpoint, the oldest beyond this many are evicted.
MAX_CHECKPOINTS_PER_SESSION = 25


@dataclass(slots=True)
class Checkpoint:
    run_id: str
    session_id: UUID
    source_root: Path
    label: str
    created_at: str
    files: list[str]


def _checkpoints_root(data_dir: str) -> Path:
    # Mirror zoc_run's layout: live outside the source workspace, namespaced by
    # data_dir so separate instances stay isolated.
    digest = hashlib.sha1(str(data_dir).encode("utf-8")).hexdigest()[:12]
    base = Path(tempfile.gettempdir()) / "zoc-agent-checkpoints" / digest
    base.mkdir(parents=True, exist_ok=True)
    return base


def _checkpoint_dir(data_dir: str, run_id: str) -> Path:
    return _checkpoints_root(data_dir) / run_id


def create_checkpoint(
    *,
    data_dir: str,
    run_id: str,
    session_id: UUID,
    source_root: Path,
    rel_paths: list[str],
    label: str = "Before applying agent changes",
) -> Checkpoint:
    """Snapshot the current (pre-apply) state of ``rel_paths`` under
    ``source_root``. Call this immediately BEFORE writing the run's changes."""
    cp_dir = _checkpoint_dir(data_dir, run_id)
    if cp_dir.exists():
        shutil.rmtree(cp_dir, ignore_errors=True)
    files_dir = cp_dir / "files"
    files_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, object]] = []
    for rel in rel_paths:
        src = source_root / rel
        existed = src.exists() and src.is_file()
        if existed:
            dst = files_dir / rel
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            except OSError:
                # Can't snapshot this file — skip it so restore never tries to
                # write back content we don't have. The rest stay restorable.
                continue
        entries.append({"path": rel, "existed": existed})

    created_at = datetime.now(UTC).isoformat()
    manifest = {
        "run_id": run_id,
        "session_id": str(session_id),
        "source_root": str(source_root),
        "label": label,
        "created_at": created_at,
        "entries": entries,
    }
    (cp_dir / _MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
    prune_checkpoints(data_dir, session_id)
    return Checkpoint(
        run_id=run_id,
        session_id=session_id,
        source_root=source_root,
        label=label,
        created_at=created_at,
        files=[str(e["path"]) for e in entries],
    )


def _read_manifest(cp_dir: Path) -> dict | None:
    manifest_path = cp_dir / _MANIFEST
    if not manifest_path.exists():
        return None
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _to_checkpoint(manifest: dict) -> Checkpoint:
    return Checkpoint(
        run_id=manifest["run_id"],
        session_id=UUID(manifest["session_id"]),
        source_root=Path(manifest["source_root"]),
        label=manifest.get("label", ""),
        created_at=manifest.get("created_at", ""),
        files=[str(e["path"]) for e in manifest.get("entries", [])],
    )


def get_checkpoint(data_dir: str, run_id: str, session_id: UUID) -> Checkpoint | None:
    manifest = _read_manifest(_checkpoint_dir(data_dir, run_id))
    if manifest is None or manifest.get("session_id") != str(session_id):
        return None
    return _to_checkpoint(manifest)


def list_checkpoints(data_dir: str, session_id: UUID) -> list[Checkpoint]:
    root = _checkpoints_root(data_dir)
    out: list[Checkpoint] = []
    for cp_dir in root.iterdir() if root.exists() else []:
        if not cp_dir.is_dir():
            continue
        manifest = _read_manifest(cp_dir)
        if manifest is None or manifest.get("session_id") != str(session_id):
            continue
        out.append(_to_checkpoint(manifest))
    # Newest first.
    out.sort(key=lambda c: c.created_at, reverse=True)
    return out


def restore_checkpoint(*, data_dir: str, run_id: str, session_id: UUID) -> list[str]:
    """Undo the applied run: restore each captured file to its pre-change state
    (revert modifications, delete creations, recreate deletions). Returns the
    list of relative paths that were restored. Raises ``KeyError`` if the
    checkpoint is unknown for this session."""
    cp_dir = _checkpoint_dir(data_dir, run_id)
    manifest = _read_manifest(cp_dir)
    if manifest is None or manifest.get("session_id") != str(session_id):
        raise KeyError(run_id)

    source_root = Path(manifest["source_root"])
    files_dir = cp_dir / "files"
    restored: list[str] = []
    for entry in manifest.get("entries", []):
        rel = str(entry["path"])
        dst = source_root / rel
        try:
            if entry.get("existed"):
                saved = files_dir / rel
                if saved.exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(saved, dst)
                    restored.append(rel)
            else:
                # Created by the run — remove it to undo the creation.
                if dst.exists() and dst.is_file():
                    dst.unlink()
                    restored.append(rel)
        except OSError:
            # Best-effort per file; a single failure shouldn't abort the rest.
            continue
    return restored


def delete_checkpoint(data_dir: str, run_id: str) -> None:
    shutil.rmtree(_checkpoint_dir(data_dir, run_id), ignore_errors=True)


def prune_checkpoints(
    data_dir: str, session_id: UUID, keep: int = MAX_CHECKPOINTS_PER_SESSION
) -> list[str]:
    """Evict this session's oldest checkpoints beyond ``keep``. Returns the run
    ids that were deleted. Best-effort; never raises."""
    stale = list_checkpoints(data_dir, session_id)[keep:]  # list is newest-first
    for cp in stale:
        delete_checkpoint(data_dir, cp.run_id)
    return [cp.run_id for cp in stale]


__all__ = [
    "Checkpoint",
    "create_checkpoint",
    "delete_checkpoint",
    "get_checkpoint",
    "list_checkpoints",
    "prune_checkpoints",
    "restore_checkpoint",
]
