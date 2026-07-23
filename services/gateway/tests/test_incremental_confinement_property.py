"""Incremental path-confinement property for workspace indexing."""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.workspace_index import _resolve_changed_files

_NAME = st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789", min_size=1, max_size=16)
_CASES = st.lists(
    st.tuples(
        st.sampled_from(
            ["relative-inside", "absolute-inside", "traversal", "absolute-outside"]
        ),
        _NAME,
    ),
    min_size=0,
    max_size=20,
)


@settings(max_examples=100, deadline=None)
@given(cases=_CASES)
def test_incremental_updates_exclude_every_outside_path(
    cases: list[tuple[str, str]],
) -> None:
    """Feature: advanced-context-engine, Property 9: path confinement.

    **Validates: Requirements 4.6**
    """
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        root = base / "workspace"
        root.mkdir()
        (root / "src").mkdir()
        outside = base / "outside"
        outside.mkdir()

        raw_paths: list[str] = []
        expected_inside: set[str] = set()
        for kind, name in cases:
            relative = f"src/{name}.py"
            if kind == "relative-inside":
                raw_paths.append(relative)
                expected_inside.add(relative)
            elif kind == "absolute-inside":
                raw_paths.append(str(root / relative))
                expected_inside.add(relative)
            elif kind == "traversal":
                raw_paths.append(f"../outside/{name}.py")
            else:
                raw_paths.append(str(outside / f"{name}.py"))

        resolved = _resolve_changed_files(root, raw_paths)
        assert set(resolved) == expected_inside
        resolved_root = root.resolve()
        for relative, path in resolved.items():
            assert relative in expected_inside
            path.resolve(strict=False).relative_to(resolved_root)
