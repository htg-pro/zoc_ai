"""Property test for steering skip-bad-keep-rest (task 8.9, R8.7).

Feature: zocai-ecosystem-rebuild, Property 35: Steering compilation skips bad
files and keeps the rest.

**Validates: Requirements 8.7**

Design Property 35 (verbatim intent): *For any* set of steering files where
some are unreadable or unparseable, the compiled output excludes exactly the
bad files and includes all readable, parseable files.

Strategy
--------
Each example draws a set of steering files with unique ``*.md`` names. Every
file is tagged with one of four kinds, three of which exercise a distinct
"bad" branch of :func:`compile_steering` and one of which is "good":

* ``good`` — valid UTF-8 text with no failure marker; must be compiled.
* ``bad_parse`` — text equal to a sentinel that the injected ``parse``
  callable rejects with ``ValueError`` (unparseable per R8.7).
* ``bad_utf8`` — raw bytes that are not valid UTF-8, so ``read_text`` raises
  ``UnicodeDecodeError`` before parsing (unreadable per R8.7).
* ``bad_dir`` — a directory whose name matches ``*.md``; the glob matches it
  but reading it as text raises ``OSError`` (unreadable per R8.7).

The files are written into a fresh temp tree (no mocks; the real filesystem
and the real compiler drive the property), compiled, and the payload is
checked: the fragments are exactly the good files in lexical path order, the
skipped list is exactly the bad files in lexical path order, the two sets are
disjoint and together cover every input file, and no bad content leaks into
the compiled text. Runs well beyond the 100-example floor.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.context.steering_compiler import compile_steering

# ── Generators ───────────────────────────────────────────────────────────────

# The sentinel that marks an unparseable file. The injected parser raises on
# exactly this text; good content is drawn from an alphabet that can never
# produce it, so the good/bad split is unambiguous.
_BAD_MARKER = "__UNPARSEABLE__"

# Good steering content: free-form ASCII letters/digits/space/newline. Cannot
# collide with the all-underscore failure marker.
_good_content = st.text(
    alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd"), whitelist_characters=" \n"),
    max_size=40,
)

# File stem: restricted to letters and digits so names are valid, unique, and
# free of path separators / glob metacharacters.
_stems = st.text(
    alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd")),
    min_size=1,
    max_size=10,
)

_kinds = st.sampled_from(["good", "bad_parse", "bad_utf8", "bad_dir"])


@st.composite
def _file_specs(draw: st.DrawFn) -> list[tuple[str, str, str]]:
    """Draw ``(name, kind, content)`` triples with unique ``*.md`` names."""
    stems = draw(st.lists(_stems, min_size=0, max_size=6, unique=True))
    specs: list[tuple[str, str, str]] = []
    for stem in stems:
        name = f"{stem}.md"
        kind = draw(_kinds)
        content = draw(_good_content) if kind == "good" else ""
        specs.append((name, kind, content))
    return specs


def _parse(raw: str) -> str:
    """Identity parse that rejects the sentinel as unparseable (R8.7)."""
    if raw == _BAD_MARKER:
        raise ValueError("unparseable steering rule")
    return raw


@settings(max_examples=200, deadline=None)
@given(specs=_file_specs())
def test_compile_skips_bad_files_and_keeps_all_good_files(
    specs: list[tuple[str, str, str]],
) -> None:
    """Property 35: bad files are excluded; every good file is compiled.

    Feature: zocai-ecosystem-rebuild, Property 35

    **Validates: Requirements 8.7**
    """
    with tempfile.TemporaryDirectory() as tmp:
        steering = Path(tmp) / "steering"
        steering.mkdir(parents=True)

        good_paths: list[str] = []
        bad_paths: list[str] = []
        good_content: dict[str, str] = {}

        for name, kind, content in specs:
            target = steering / name
            if kind == "good":
                target.write_text(content, encoding="utf-8")
                path_str = str(target)
                good_paths.append(path_str)
                good_content[path_str] = content
            elif kind == "bad_parse":
                target.write_text(_BAD_MARKER, encoding="utf-8")
                bad_paths.append(str(target))
            elif kind == "bad_utf8":
                target.write_bytes(b"\xff\xfe\x00not-utf8")
                bad_paths.append(str(target))
            else:  # bad_dir: a directory whose name matches the glob
                target.mkdir()
                bad_paths.append(str(target))

        payload = compile_steering(steering, parse=_parse)

        fragment_paths = [f.path for f in payload.fragments]

        # Every good file is included, in lexical path order (and only good).
        assert fragment_paths == sorted(good_paths)
        # The compiled content matches exactly what was written for good files.
        for fragment in payload.fragments:
            assert fragment.content == good_content[fragment.path]
        # Exactly the bad files are skipped, in lexical path order.
        assert list(payload.skipped) == sorted(bad_paths)
        # Inclusion and exclusion sets are disjoint and cover every input file.
        assert set(fragment_paths).isdisjoint(payload.skipped)
        assert set(fragment_paths) | set(payload.skipped) == set(
            good_paths
        ) | set(bad_paths)
        # No bad file's content leaks into the compiled text.
        assert _BAD_MARKER not in payload.text


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
