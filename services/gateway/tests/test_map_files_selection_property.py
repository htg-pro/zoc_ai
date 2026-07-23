"""MAP_FILES selection confinement and cap property."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.steering_compiler import MAX_READ_FILES, select_map_files

_NAME = st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789", min_size=1, max_size=14)
_ENTRY = st.tuples(
    st.sampled_from(
        ["relative", "normalized", "absolute-inside", "traversal", "absolute-outside"]
    ),
    _NAME,
)


@settings(max_examples=100, deadline=None)
@given(
    read_entries=st.lists(_ENTRY, max_size=20),
    write_entries=st.lists(_ENTRY, max_size=20),
)
def test_file_selection_confines_paths_and_caps_reads(
    read_entries: list[tuple[str, str]],
    write_entries: list[tuple[str, str]],
) -> None:
    """Feature: advanced-context-engine, Property 16: selection confinement.

    **Validates: Requirements 12.5, 12.6**
    """
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        root = base / "workspace"
        root.mkdir()
        outside = base / "outside"
        outside.mkdir()

        def render(entries: list[tuple[str, str]]) -> list[str]:
            paths: list[str] = []
            for kind, name in entries:
                relative = f"src/{name}.py"
                if kind == "relative":
                    paths.append(relative)
                elif kind == "normalized":
                    paths.append(f"src/../{name}.py")
                elif kind == "absolute-inside":
                    paths.append(str(root / relative))
                elif kind == "traversal":
                    paths.append(f"../outside/{name}.py")
                else:
                    paths.append(str(outside / f"{name}.py"))
            return paths

        payload = {
            "read": render(read_entries),
            "write": render(write_entries),
            "rationale": "generated",
        }
        event = select_map_files(
            "task",
            (),
            select=lambda _prompt: json.dumps(payload),
            workspace_root=root,
        )

        assert len(event.read_list) <= MAX_READ_FILES == 8
        resolved_root = root.resolve()
        for path in (*event.read_list, *event.write_list):
            resolved = (resolved_root / path).resolve(strict=False)
            resolved.relative_to(resolved_root)
            assert not Path(path).is_absolute()
            assert path not in {"", "."}
        assert len(event.read_list) == len(set(event.read_list))
        assert len(event.write_list) == len(set(event.write_list))
