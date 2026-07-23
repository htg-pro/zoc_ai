"""READ_FILES injection property for framing, capping, and skipping."""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.steering_compiler import (
    PER_FILE_TOKEN_CAP,
    TRUNCATION_MARKER,
    build_read_files_payload,
)
from zocai_gateway.context.token_gate import CHARS_PER_TOKEN, estimate_tokens

_NAME = st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789", min_size=1, max_size=12)
_FILE_CASES = st.lists(
    st.tuples(_NAME, st.integers(min_value=0, max_value=10_000), st.booleans()),
    min_size=0,
    max_size=12,
    unique_by=lambda item: item[0],
)


@settings(max_examples=100, deadline=None)
@given(cases=_FILE_CASES)
def test_read_files_is_framed_capped_and_skips_unreadable(
    cases: list[tuple[str, int, bool]],
) -> None:
    """Feature: advanced-context-engine, Property 17: READ_FILES injection.

    **Validates: Requirements 15.2, 15.3, 15.4**
    """
    paths = [f"src/{name}.py" for name, _length, _unreadable in cases]
    contents = {
        f"src/{name}.py": "x" * length
        for name, length, _unreadable in cases
    }
    unreadable = {
        f"src/{name}.py"
        for name, _length, is_unreadable in cases
        if is_unreadable
    }

    def read_file(path: str) -> str:
        if path in unreadable:
            raise OSError("unreadable")
        return contents[path]

    payload = build_read_files_payload(paths, read_file)
    expected_blocks: list[str] = []
    max_chars = PER_FILE_TOKEN_CAP * CHARS_PER_TOKEN
    suffix = f"\n{TRUNCATION_MARKER}"

    for path in paths:
        header = f"=== FILE: {path} ===\n"
        if path in unreadable:
            assert header not in payload
            continue
        original = contents[path]
        if estimate_tokens(original) > PER_FILE_TOKEN_CAP:
            capped = original[: max_chars - len(suffix)] + suffix
            assert capped.endswith(TRUNCATION_MARKER)
        else:
            capped = original
            assert TRUNCATION_MARKER not in capped
        assert estimate_tokens(capped) <= PER_FILE_TOKEN_CAP
        expected_blocks.append(f"{header}{capped}\n")

    assert payload == "".join(expected_blocks)
