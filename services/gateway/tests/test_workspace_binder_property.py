"""Property tests for the Workspace_Binder (zoc-ai-agent-chat-overhaul).

Feature: zoc-ai-agent-chat-overhaul, Property 1 and Property 3.
"""

from __future__ import annotations

import json
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from zocai_gateway.workspace_binder import WorkspaceBinder, WorkspaceOutsideError

# Directory names that are safe on the filesystem (no separators / dots-only).
_dir_names = st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789_", min_size=1, max_size=12)


def _write_config(config_path: Path, root: Path) -> None:
    config_path.write_text(json.dumps({"workspace_root": str(root)}), encoding="utf-8")


# ── Property 1: binder resolves the latest persisted root ────────────────────


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(names=st.lists(_dir_names, min_size=1, max_size=6, unique=True))
def test_binder_resolves_latest_persisted_root(names: list[str]) -> None:
    """Property 1: every resolution returns the canonical form of the latest write.

    Feature: zoc-ai-agent-chat-overhaul, Property 1

    **Validates: Requirements 1.1, 1.2, 1.6**
    """
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        config = base / "desktop.json"
        # One long-lived binder proves no process restart is needed between a
        # write and the resolution that observes it (R1.2).
        binder = WorkspaceBinder(config_path=config, env={})
        for name in names:
            root = base / name
            root.mkdir(exist_ok=True)
            _write_config(config, root)
            resolved = binder.resolve()
            assert resolved is not None
            assert resolved.root_path == str(root.resolve())
            # A freshly constructed binder resolves the same persisted root (R1.6).
            fresh = WorkspaceBinder(config_path=config, env={})
            assert fresh.resolve() is not None
            assert fresh.resolve().root_path == str(root.resolve())


# ── Property 3: every resolved path stays inside the workspace root ──────────

# Candidate fragments that exercise traversal, sibling-prefix, and nesting.
_segments = st.sampled_from(["..", ".", "a", "b", "sub", "child", "x"])
_candidates = st.lists(_segments, min_size=1, max_size=6).map(lambda parts: "/".join(parts))


@settings(max_examples=200, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(candidate=_candidates)
def test_resolved_path_stays_inside_root(candidate: str) -> None:
    """Property 3: a resolved path is inside the root or raises a containment error.

    Feature: zoc-ai-agent-chat-overhaul, Property 3

    **Validates: Requirements 1.5, 12.4**
    """
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        root = base / "project"
        root.mkdir()
        # A sibling with a shared prefix must never be accepted as "inside".
        (base / "project-evil").mkdir()
        config = base / "desktop.json"
        _write_config(config, root)
        binder = WorkspaceBinder(config_path=config, env={})
        canonical_root = root.resolve()

        try:
            resolved = binder.resolve_path(candidate)
        except WorkspaceOutsideError as exc:
            assert exc.rejected == candidate
        else:
            assert resolved == canonical_root or canonical_root in resolved.parents


@settings(max_examples=50, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(link_name=_dir_names)
def test_symlink_escape_is_rejected(link_name: str) -> None:
    """Property 3: a symlink pointing outside the root is rejected (R1.5).

    Feature: zoc-ai-agent-chat-overhaul, Property 3

    **Validates: Requirements 1.5, 12.4**
    """
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        root = base / "project"
        root.mkdir()
        outside = base / "outside"
        outside.mkdir()
        config = base / "desktop.json"
        _write_config(config, root)
        binder = WorkspaceBinder(config_path=config, env={})

        link = root / link_name
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):  # pragma: no cover - platform dependent
            return
        # Resolving through the symlink follows it outside the root, so it is
        # rejected even though the link file itself lives inside the root.
        try:
            resolved = binder.resolve_path(f"{link_name}/file.txt")
        except WorkspaceOutsideError:
            pass
        else:  # pragma: no cover - a followed symlink must escape
            raise AssertionError(f"symlink escape was accepted: {resolved}")
