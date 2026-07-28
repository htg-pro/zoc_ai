"""Schema-drift guard — zoc-agent-chat-rebuild R7.4, R22.5.

Two assertions, and the second one is the one that matters:

  1. `pnpm schema:generate` followed by `pnpm schema:check` exits 0 in a clean
     tree.
  2. A hand-edit to `message-parts.ts` makes `pnpm schema:check` exit 1.

Without (2), (1) is satisfied by a `--check` that always succeeds, which is
exactly the failure mode a drift gate exists to rule out. Every hand-edit here
is restored in a `finally`, so a failing assertion cannot leave the working tree
dirty.

Each assertion is made twice: once against the generator invoked directly, which
is fast and lets the three emitted files be parameterised cheaply, and once
through `pnpm` itself, which is the command R7.4 names and the only path that
covers the `package.json` wiring. A `schema:check` that lost its `--check` flag
would *write* the files and exit 0 — a dead gate that a test hard-coding the
flag could never see. So the argv is read from `package.json` rather than
spelled out here.

Requirements: 7.4, 22.5
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
TS_DIR = REPO_ROOT / "packages" / "shared-types" / "typescript" / "src"

#: Every file the generator emits. R7.4 covers the whole directory, not just the
#: module this milestone adds, so the hand-edit case is parameterised across all
#: three rather than asserted once against `message-parts.ts`.
GENERATED = ("index.ts", "agent-events.ts", "message-parts.ts")

requires_pnpm = pytest.mark.skipif(
    shutil.which("pnpm") is None, reason="pnpm is not on PATH in this environment"
)


def _scripts() -> dict[str, str]:
    return json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]


def _argv(script: str) -> list[str]:
    """The command `pnpm <script>` runs, re-pointed at this interpreter."""
    interpreter, script_path, *flags = _scripts()[script].split()
    assert interpreter in ("python", "python3"), (
        f"`{script}` no longer invokes a Python interpreter: {interpreter}"
    )
    return [sys.executable, str(REPO_ROOT / script_path), *flags]


def _run(script: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        _argv(script),
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    )


def _pnpm(script: str) -> subprocess.CompletedProcess[str]:
    """Run the real `pnpm <script>`, with `python` bound to this interpreter.

    Prepending the running interpreter's directory keeps the assertion about the
    wiring — script path, flag, `pnpm` resolution — rather than about which
    `python` happens to come first on the machine's PATH.
    """
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(Path(sys.executable).parent), env.get("PATH", "")])
    return subprocess.run(
        ["pnpm", script],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
        check=False,
    )


def test_build_gate_wires_the_schema_step() -> None:
    """R22.5: the gate only guards if `pnpm check` runs it."""
    scripts = _scripts()
    generator = "packages/shared-types/scripts/generate_ts.py"
    assert scripts["schema:generate"] == f"python {generator}"
    assert scripts["schema:check"] == f"python {generator} --check"
    assert "pnpm schema:check" in scripts["check"]


def test_the_registry_covers_every_generated_file() -> None:
    """A registered module that emits no file is a silently missing gate."""
    sys.path.insert(0, str(REPO_ROOT / "packages" / "shared-types" / "scripts"))
    import generate_ts

    assert {path.name for path in generate_ts.generated_files()} == set(GENERATED)

    assert _run("schema:generate").returncode == 0
    for name in GENERATED:
        assert (TS_DIR / name).exists(), f"{name} was not generated"


def test_generate_then_check_is_clean() -> None:
    """Guard, first half — and generation is a no-op on a clean tree.

    Snapshotting the bytes first is what makes this an assertion about the
    *committed* output: a `schema:generate` that rewrote a committed file would
    leave the following `schema:check` green while having changed the very thing
    under test.
    """
    before = {name: (TS_DIR / name).read_bytes() for name in GENERATED}
    assert _run("schema:generate").returncode == 0, "generation itself failed"
    after = {name: (TS_DIR / name).read_bytes() for name in GENERATED}
    assert after == before, "schema:generate rewrote committed output"

    result = _run("schema:check")
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("name", GENERATED)
def test_hand_edit_is_detected(name: str) -> None:
    """Guard, second half, for every generated file (R7.4)."""
    target = TS_DIR / name
    original = target.read_text(encoding="utf-8")
    try:
        target.write_text(original + "\nexport type HandEditedDrift = true;\n", encoding="utf-8")
        result = _run("schema:check")
        assert result.returncode == 1, (
            f"schema:check accepted a hand-edited {name}; the drift gate is not actually gating"
        )
        assert name in result.stderr
    finally:
        target.write_text(original, encoding="utf-8")

    assert _run("schema:check").returncode == 0, "restore left the tree dirty"


@requires_pnpm
def test_pnpm_generate_then_check_is_clean() -> None:
    """The guard as written: `pnpm schema:generate` then `pnpm schema:check`."""
    assert _pnpm("schema:generate").returncode == 0, "pnpm schema:generate failed"
    result = _pnpm("schema:check")
    assert result.returncode == 0, result.stderr


@requires_pnpm
def test_pnpm_check_fails_on_a_hand_edited_message_parts() -> None:
    """The assertion that rules out a `--check` that always succeeds."""
    target = TS_DIR / "message-parts.ts"
    original = target.read_text(encoding="utf-8")
    try:
        target.write_text(
            original.replace("export type UUID = string;", "export type UUID = number;"),
            encoding="utf-8",
        )
        assert target.read_text(encoding="utf-8") != original, "the edit did not apply"
        result = _pnpm("schema:check")
        assert result.returncode == 1, (
            "pnpm schema:check accepted a hand-edited message-parts.ts; the "
            "Build_Gate would ship drift"
        )
    finally:
        target.write_text(original, encoding="utf-8")

    assert _pnpm("schema:check").returncode == 0, "restore left the tree dirty"
