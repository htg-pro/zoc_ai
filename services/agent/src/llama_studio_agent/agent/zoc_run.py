"""Isolated Agent-run workflow (Zoc AI redesign).

Implements the review-before-apply model from the redesign plan (Part 2.5):
an Agent-mode run executes inside an isolated *copy* of the workspace, so the
real project is never touched until the user clicks **Apply changes**. This is
what makes "Checkpoints let you roll back" real and removes any need for an
approve-to-*start* gate.

Reuses the proven primitives from ``replit_workflow`` (``copy_workspace``,
``build_workspace_diff``, ``changed_files``, ``run_validation_suite``) instead
of duplicating them — this module just owns the per-run lifecycle + registry
and the apply/discard operations.
"""

from __future__ import annotations

import contextlib
import hashlib
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

from .checkpoints import create_checkpoint
from .validation import (
    format_validation_results,
    run_validation_suite,
)
from .workspace_diff import (
    build_workspace_diff,
    changed_files,
    copy_workspace,
)


@dataclass(slots=True)
class IsolatedRun:
    """One Agent run executing against an isolated workspace copy."""

    run_id: str
    session_id: UUID
    source_root: Path
    workspace: Path
    # The instance data dir, needed to locate the checkpoint store at apply time.
    data_dir: str = ""
    status: str = "running"  # running | awaiting_review | applying | applied | discarded | error
    diff: str = ""
    validation: dict[str, str] = field(default_factory=dict)
    changed: list[str] = field(default_factory=list)
    # Files that could not be written to the real workspace during apply
    # (e.g. permission denied, disk full). Empty on a clean apply.
    failed: list[str] = field(default_factory=list)


# In-memory registry of active/finished isolated runs, keyed by run_id.
# A finished run is kept until applied/discarded so the endpoints can resolve
# it. Bounded in practice by user activity; evicted on apply/discard.
_RUNS: dict[str, IsolatedRun] = {}


def _runs_root(data_dir: str) -> Path:
    # IMPORTANT: the isolated copy MUST live *outside* the source workspace,
    # otherwise copying the workspace would recurse into its own destination.
    # ``data_dir`` is frequently nested inside the project root (and in tests it
    # is literally ``<workspace>/data``), so we anchor runs in the system temp
    # directory, namespaced by ``data_dir`` to keep separate instances isolated.
    digest = hashlib.sha1(str(data_dir).encode("utf-8")).hexdigest()[:12]
    base = Path(tempfile.gettempdir()) / "zoc-agent-runs" / digest
    base.mkdir(parents=True, exist_ok=True)
    return base


def prepare_isolated_run(
    *, data_dir: str, run_id: str, session_id: UUID, source_root: Path
) -> IsolatedRun:
    """Create the isolated copy and register the run."""
    if not source_root.exists() or not source_root.is_dir():
        raise ValueError(f"source workspace does not exist: {source_root}")
    workspace = _runs_root(data_dir) / run_id / "workspace"
    if workspace.exists():
        shutil.rmtree(workspace, ignore_errors=True)
    workspace.parent.mkdir(parents=True, exist_ok=True)
    copy_workspace(source_root, workspace)
    run = IsolatedRun(
        run_id=run_id,
        session_id=session_id,
        source_root=source_root,
        workspace=workspace,
        data_dir=data_dir,
    )
    _RUNS[run_id] = run
    return run


def finalize_isolated_run(run: IsolatedRun) -> IsolatedRun:
    """After the agent loop: compute the aggregated diff + validation and set
    the run's terminal-but-pending status (awaiting_review when changed, else
    applied with nothing to do)."""
    run.changed = changed_files(run.source_root, run.workspace)
    if not run.changed:
        run.status = "applied"  # no changes — nothing to review
        run.diff = ""
        return run
    run.diff = build_workspace_diff(run.source_root, run.workspace)
    results = run_validation_suite(run.workspace)
    run.validation = {r.label: ("pass" if r.passed else "fail") for r in results}
    run.status = "awaiting_review"
    return run


def get_run(run_id: str, session_id: UUID) -> IsolatedRun | None:
    run = _RUNS.get(run_id)
    if run is None or run.session_id != session_id:
        return None
    return run


def apply_isolated_run(run: IsolatedRun) -> list[str]:
    """Copy the changed files from the isolated copy onto the real workspace.
    This is the single explicit approval gate — only ever called from the
    Apply endpoint, never inferred.

    Hardened: each file is applied independently so one failure (permission
    denied, disk full, a path that turned into a directory) doesn't abort the
    whole apply or leave the run leaked. Failures are recorded on
    ``run.failed`` and the isolated copy is always cleaned up afterwards.
    Returns the list of files successfully applied.
    """
    run.status = "applying"
    applied: list[str] = []
    failed: list[str] = []
    try:
        changed = changed_files(run.source_root, run.workspace)
        # Snapshot the pre-change state of exactly these files BEFORE writing,
        # so the run can be undone later via restore_checkpoint (Checkpoints).
        # Best-effort: a snapshot failure must never block the apply itself —
        # the user just loses one-click undo for this run.
        if changed and run.data_dir:
            with contextlib.suppress(OSError):
                create_checkpoint(
                    data_dir=run.data_dir,
                    run_id=run.run_id,
                    session_id=run.session_id,
                    source_root=run.source_root,
                    rel_paths=changed,
                )
        for rel in changed:
            src = run.workspace / rel
            dst = run.source_root / rel
            try:
                if src.exists() and src.is_file():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    # Replacing a path that is unexpectedly a directory would
                    # raise; treat it as a per-file failure rather than aborting.
                    shutil.copy2(src, dst)
                elif dst.exists() and dst.is_file():
                    dst.unlink()
                applied.append(rel)
            except OSError:
                failed.append(rel)
        run.failed = failed
        run.status = "applied" if not failed else "error"
        return applied
    finally:
        # Always drop the isolated copy + registry entry, even on partial
        # failure, so a failed apply can never leak temp dirs or memory.
        _cleanup(run)


def discard_isolated_run(run: IsolatedRun) -> None:
    """Throw away the isolated copy entirely — the real workspace is untouched."""
    run.status = "discarded"
    _cleanup(run)


def _cleanup(run: IsolatedRun) -> None:
    shutil.rmtree(run.workspace.parent, ignore_errors=True)
    _RUNS.pop(run.run_id, None)


__all__ = [
    "IsolatedRun",
    "apply_isolated_run",
    "discard_isolated_run",
    "finalize_isolated_run",
    "format_validation_results",
    "get_run",
    "prepare_isolated_run",
]
