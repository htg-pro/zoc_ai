"""Guard for the traceability gate — zoc-agent-chat-rebuild R24.1, R24.2, task 27.2.

Four boundaries, all asserted against a synthetic tree rather than the repository,
because the repository is clean and a clean tree cannot show what the gate rejects:
the missing marker, the marker with no identifier behind it, the trees the gate does
*not* own, and the file types it ignores. The last test is the exception — it runs
the gate over the real checkout, which is the only assertion that the guarded trees
are actually clean today.

Each accepted identifier form is parameterised. The pattern has three alternatives
and a regression that broke only the `Property N` branch would otherwise pass.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import traceability  # noqa: E402

CHAT = "apps/frontend/src/features/chat/Row.tsx"
RUNTIME = "apps/agent-runtime/src/main.ts"
LEGACY = "apps/frontend/src/features/agent/rows.tsx"


def write(root: Path, rel: str, body: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def run(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS / "traceability.py"), "--root", str(root)],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("identifier", ["R24.1", "task 27.2", "Property 44"])
def test_marker_with_any_accepted_identifier_passes(tmp_path: Path, identifier: str) -> None:
    write(tmp_path, CHAT, f"/**\n * {traceability.MARKER}, {identifier}.\n */\n")
    write(tmp_path, RUNTIME, f"// {traceability.MARKER}, {identifier}\n")

    result = run(tmp_path)

    assert result.returncode == 0, result.stderr
    assert "2 files" in result.stdout


def test_missing_marker_is_named(tmp_path: Path) -> None:
    write(tmp_path, CHAT, "/**\n * A row, R24.1.\n */\n")

    result = run(tmp_path)

    assert result.returncode == 1
    assert CHAT in result.stderr
    assert "carry no" in result.stderr


def test_marker_without_an_identifier_is_named(tmp_path: Path) -> None:
    write(tmp_path, CHAT, f"/**\n * {traceability.MARKER}.\n */\n")

    result = run(tmp_path)

    assert result.returncode == 1
    assert CHAT in result.stderr
    assert "cite no requirement" in result.stderr


def test_unguarded_trees_and_non_source_files_are_left_alone(tmp_path: Path) -> None:
    write(tmp_path, LEGACY, "export const rows = [];\n")
    write(tmp_path, "apps/frontend/src/features/chat/notes.md", "no marker here\n")
    write(tmp_path, "apps/frontend/src/features/chat/row.css", ".row {}\n")

    result = run(tmp_path)

    assert result.returncode == 0, result.stderr
    assert "0 files" in result.stdout


def test_the_repository_is_clean() -> None:
    unmarked, uncited = traceability.failures(REPO_ROOT)

    assert unmarked == []
    assert uncited == []
    assert len(traceability.guarded_files(REPO_ROOT)) > 200
