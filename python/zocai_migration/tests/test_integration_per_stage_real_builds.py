"""Integration test for per-stage real language builds (task 15.3).

Feature: zocai-ecosystem-rebuild.

**Validates: Requirements 13.6**

R13.6 requires that, when the Migration completes a stage, the affected
language build (Python, Rust, or TypeScript) completes with a **zero exit
code** before proceeding to the next stage. Every other test in this package
drives that discipline through in-memory build-runner fakes that *return* an
exit code. This module closes the loop by invoking the **real** post-cutover
language builds via ``subprocess`` against the live workspace and asserting
each one genuinely exits 0.

One build is exercised per language stage, deliberately kept minimal because
these are real toolchain invocations and can be slow:

* **TypeScript** -- ``pnpm --filter @zoc-studio/frontend typecheck`` (the
  preserved product frontend deliverable, Layer 1; the merge overrides the
  Rebuild plan's ``workbench`` deliverable with ``apps/frontend``).
* **Rust** -- ``cargo check -p hardware-probe`` (the hot-path hardware probe
  crate).
* **Python** -- ``mypy`` over the production sources of the FastAPI gateway
  (``services/gateway/src``) and the evolution engine
  (``python/zocai_evolution/src``).

If a required toolchain (``pnpm``/``cargo``/``mypy``) is unavailable, the
corresponding stage is **skipped gracefully** so the suite stays runnable in
minimal environments.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

# tests/ -> zocai_migration/ -> python/ -> workspace root
WORKSPACE_ROOT = Path(__file__).resolve().parents[3]

# Generous ceiling: real builds compile/typecheck source but are bounded.
BUILD_TIMEOUT_SECONDS = 600


@dataclass(frozen=True)
class StageBuild:
    """A single per-language migration-stage build to exercise for real."""

    language: str
    label: str
    argv: tuple[str, ...]
    available: bool
    skip_reason: str


def _pnpm_available() -> bool:
    return shutil.which("pnpm") is not None


def _cargo_available() -> bool:
    return shutil.which("cargo") is not None


def _mypy_available() -> bool:
    # Invoked as ``python -m mypy`` below, so detect the importable module in
    # the active (repo .venv) interpreter rather than relying on a PATH shim.
    return importlib.util.find_spec("mypy") is not None


STAGE_BUILDS: tuple[StageBuild, ...] = (
    StageBuild(
        language="typescript",
        label="TS build: pnpm --filter @zoc-studio/frontend typecheck",
        argv=("pnpm", "--filter", "@zoc-studio/frontend", "typecheck"),
        available=_pnpm_available(),
        skip_reason="pnpm executable not available on PATH",
    ),
    StageBuild(
        language="rust",
        label="Rust build: cargo check -p hardware-probe",
        argv=("cargo", "check", "-p", "hardware-probe"),
        available=_cargo_available(),
        skip_reason="cargo executable not available on PATH",
    ),
    StageBuild(
        language="python",
        label="Python build: mypy gateway + evolution sources",
        argv=(
            sys.executable,
            "-m",
            "mypy",
            "services/gateway/src",
            "python/zocai_evolution/src",
        ),
        available=_mypy_available(),
        skip_reason="mypy not importable in the active interpreter",
    ),
)


def _run_build(stage: StageBuild) -> subprocess.CompletedProcess[str]:
    """Run a real stage build at the workspace root, capturing all output."""
    return subprocess.run(  # noqa: S603 - argv form, no shell, workspace-confined cwd
        list(stage.argv),
        cwd=WORKSPACE_ROOT,
        capture_output=True,
        text=True,
        timeout=BUILD_TIMEOUT_SECONDS,
        check=False,
    )


@pytest.mark.integration
@pytest.mark.parametrize("stage", STAGE_BUILDS, ids=lambda s: s.language)
def test_stage_real_language_build_exits_zero(stage: StageBuild) -> None:
    """Each migration stage's real language build returns exit code 0.

    **Validates: Requirements 13.6**
    """
    if not stage.available:
        pytest.skip(f"{stage.label}: {stage.skip_reason}")

    result = _run_build(stage)

    assert result.returncode == 0, (
        f"{stage.label} did not complete with a zero exit code "
        f"(exit={result.returncode}).\n"
        f"--- stdout ---\n{result.stdout}\n"
        f"--- stderr ---\n{result.stderr}"
    )


def test_one_build_per_language_stage_is_covered() -> None:
    """The suite exercises exactly one real build per language stage.

    Guards the minimal-but-real intent of R13.6 coverage: a single build for
    each of the three language stages (Python, Rust, TypeScript), no more and
    no fewer, so the integration set stays fast yet representative.
    """
    languages = [stage.language for stage in STAGE_BUILDS]
    assert sorted(languages) == ["python", "rust", "typescript"]
    assert len(languages) == len(set(languages)), "duplicate language stage build"
