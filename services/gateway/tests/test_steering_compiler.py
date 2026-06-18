"""Unit tests for the ``Steering_Compiler`` (task 8.2, R8.2 + R8.7).

These example-based tests cover the two behaviors the task calls out:
lexical path ordering of the compiled payload, and skip-bad-keep-rest when a
matched file cannot be read or parsed. The exhaustive property tests live in
tasks 8.8 (Property 34) and 8.9 (Property 35).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from zocai_gateway.context.steering_compiler import (
    SteeringPayload,
    compile_steering,
)


def _write(steering_dir: Path, name: str, content: str) -> None:
    steering_dir.mkdir(parents=True, exist_ok=True)
    (steering_dir / name).write_text(content, encoding="utf-8")


def test_missing_directory_yields_empty_payload(tmp_path: Path) -> None:
    payload = compile_steering(tmp_path / "does-not-exist")
    assert payload == SteeringPayload()
    assert payload.fragments == ()
    assert payload.text == ""


def test_only_md_files_are_matched(tmp_path: Path) -> None:
    steering = tmp_path / "steering"
    _write(steering, "rules.md", "md")
    _write(steering, "notes.txt", "txt")
    _write(steering, "data.json", "{}")

    payload = compile_steering(steering)

    assert [f.path for f in payload.fragments] == [str(steering / "rules.md")]


def test_fragments_are_in_lexical_path_order(tmp_path: Path) -> None:
    steering = tmp_path / "steering"
    # Intentionally created out of lexical order.
    _write(steering, "30-style.md", "C")
    _write(steering, "10-intro.md", "A")
    _write(steering, "20-rules.md", "B")

    payload = compile_steering(steering)

    paths = [f.path for f in payload.fragments]
    assert paths == sorted(paths)
    assert [f.content for f in payload.fragments] == ["A", "B", "C"]
    assert payload.text == "A\n\nB\n\nC"


def test_skips_unparseable_file_and_keeps_the_rest(tmp_path: Path) -> None:
    steering = tmp_path / "steering"
    _write(steering, "a.md", "alpha")
    _write(steering, "b.md", "BAD")
    _write(steering, "c.md", "gamma")

    def parse(raw: str) -> str:
        if raw == "BAD":
            raise ValueError("unparseable steering rule")
        return raw

    payload = compile_steering(steering, parse=parse)

    assert [f.path for f in payload.fragments] == [
        str(steering / "a.md"),
        str(steering / "c.md"),
    ]
    assert payload.skipped == (str(steering / "b.md"),)
    assert "BAD" not in payload.text


def test_skips_unreadable_file_and_keeps_the_rest(tmp_path: Path) -> None:
    steering = tmp_path / "steering"
    _write(steering, "a.md", "alpha")
    _write(steering, "c.md", "gamma")
    # A directory whose name matches *.md is matched by the glob but cannot be
    # read as text (IsADirectoryError -> OSError), exercising the unreadable
    # branch deterministically.
    (steering / "b.md").mkdir()

    payload = compile_steering(steering)

    assert [f.path for f in payload.fragments] == [
        str(steering / "a.md"),
        str(steering / "c.md"),
    ]
    assert payload.skipped == (str(steering / "b.md"),)


def test_invalid_utf8_file_is_skipped(tmp_path: Path) -> None:
    steering = tmp_path / "steering"
    steering.mkdir(parents=True)
    _write(steering, "ok.md", "fine")
    (steering / "bad.md").write_bytes(b"\xff\xfe\x00invalid")

    payload = compile_steering(steering)

    assert [f.path for f in payload.fragments] == [str(steering / "ok.md")]
    assert payload.skipped == (str(steering / "bad.md"),)


def test_empty_directory_yields_empty_payload(tmp_path: Path) -> None:
    steering = tmp_path / "steering"
    steering.mkdir()
    assert compile_steering(steering) == SteeringPayload()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
