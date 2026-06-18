"""Property test for steering lexical ordering (task 8.8).

Feature: zocai-ecosystem-rebuild, Property 34: Steering files compile in
lexical path order.

**Validates: Requirements 8.2**

Design Property 34 (verbatim intent): *For any* set of steering files, the
compiled output orders the files by lexical path order.

The ordering behavior lives in
:func:`zocai_gateway.context.steering_compiler.compile_steering`, which reads
``*.md`` files from an (injectable) steering directory and compiles them into a
:class:`~zocai_gateway.context.steering_compiler.SteeringPayload` sorted by the
string form of each file's path (R8.2). This property is exercised against the
real compiler (no mocks): each generated example materializes a set of distinct
steering files in a fresh temporary directory and asserts that the compiled
fragments — and the concatenated payload text — appear in lexical path order.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.context.steering_compiler import compile_steering

# Safe, case-sensitive-distinct file-name characters. Restricting the alphabet
# keeps generated names valid on disk while still spanning the orderings that
# matter (digits sort before letters, upper before lower in code-point order).
_NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"

# A base name (".md" is appended later). Distinct base names => distinct paths.
_BASE_NAME = st.text(alphabet=_NAME_CHARS, min_size=1, max_size=24)

# Free-form Markdown content for a steering file; content need not be distinct
# for the ordering property, but is allowed to vary arbitrarily.
_CONTENT = st.text(max_size=64)

# A set of steering files: a mapping of unique base name -> content. At least
# two files so ordering is non-trivial; capped so each example stays cheap.
_STEERING_FILES = st.dictionaries(
    keys=_BASE_NAME,
    values=_CONTENT,
    min_size=2,
    max_size=8,
)


@settings(max_examples=200)
@given(files=_STEERING_FILES)
def test_steering_files_compile_in_lexical_path_order(
    files: dict[str, str],
) -> None:
    """Property 34: the compiled payload is ordered by lexical path.

    Feature: zocai-ecosystem-rebuild, Property 34

    **Validates: Requirements 8.2**
    """
    with tempfile.TemporaryDirectory() as raw_dir:
        steering = Path(raw_dir) / "steering"
        steering.mkdir()

        # Materialize the steering files in arbitrary (dict iteration) order so
        # the compiler — not the test's write order — must establish ordering.
        for base, content in files.items():
            (steering / f"{base}.md").write_text(content, encoding="utf-8")

        payload = compile_steering(steering)

        # Every generated file is readable/parseable, so all are included.
        compiled_paths = [fragment.path for fragment in payload.fragments]
        assert len(compiled_paths) == len(files)

        # The fragments appear in lexical (string) order of their path (R8.2).
        assert compiled_paths == sorted(compiled_paths)

        # That order matches sorting the on-disk paths independently.
        expected_paths = sorted(str(steering / f"{base}.md") for base in files)
        assert compiled_paths == expected_paths

        # The concatenated payload text follows the same lexical path order:
        # each fragment's content sits at the position dictated by its path.
        # Expected content is read back the same way the compiler reads it
        # (text-mode UTF-8), so this assertion isolates *ordering* and is not
        # sensitive to newline normalization performed by text-mode I/O.
        expected_text = "\n\n".join(
            Path(path).read_text(encoding="utf-8") for path in expected_paths
        )
        assert payload.text == expected_text
