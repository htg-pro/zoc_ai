"""Post-cutover smoke test for the three-language Ecosystem (task 15.2).

Feature: zocai-ecosystem-rebuild.

**Validates: Requirements 13.1, 9.1**

This is the end-state acceptance smoke test for the build-gated legacy cutover
(R13). Unlike the controller property/unit suites, which model the migration
against in-memory fakes, this test inspects the **real workspace on disk** and
asserts the migration's defining outcome:

* R13.1 -- the Migration delivers the Ecosystem such that the Python FastAPI
  backend sidecar (``services/gateway``), the Rust crate
  (``crates/hardware-probe``), and the TypeScript/React frontend
  (``apps/frontend``) all exist, and the Migration is *considered complete only
  when all three of these components exist*. The completion predicate
  :func:`migration_complete` encodes exactly that "all three or nothing" rule
  and is exercised across every present/absent combination.

* R9.1 -- the Memory_Matrix stores all data within the workspace ``.zocai/``
  directory and creates the missing directory and tier sub-stores on first
  initialization. We drive :class:`MemoryMatrix.initialize` against a throwaway
  ``tmp_path`` workspace and assert the ``.zocai/`` tree springs into existence,
  fully confined under that root.

The deliverable check is build-*manifest* based (``pyproject.toml`` /
``Cargo.toml`` / ``package.json`` present and parseable) so the smoke test stays
fast and deterministic; task 15.3 covers the per-stage *real* language builds
returning exit code 0.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest

from zocai_gateway.memory.matrix import MemoryMatrix


# ---------------------------------------------------------------------------
# Workspace discovery
# ---------------------------------------------------------------------------


def _find_workspace_root() -> Path:
    """Walk upward from this test file to the monorepo root.

    The root is identified by the co-location of the three top-level build
    manifests that anchor the multi-language workspace (pnpm + Cargo + uv).
    Searching for a marker rather than hard-coding ``parents[n]`` keeps the
    test robust if the package is relocated within the tree.
    """
    markers = ("pnpm-workspace.yaml", "Cargo.toml", "pyproject.toml")
    for candidate in (Path(__file__).resolve(), *Path(__file__).resolve().parents):
        if candidate.is_dir() and all((candidate / m).is_file() for m in markers):
            return candidate
    raise RuntimeError("could not locate the monorepo workspace root")


WORKSPACE_ROOT = _find_workspace_root()

# The three language deliverables and their canonical build manifests (R13.1).
# NOTE (zoc-agent-ecosystem-merge): this overrides the Rebuild migration plan,
# which named ``apps/workbench`` as the TS deliverable. The merge preserves
# ``apps/frontend`` as the single product app and deletes ``apps/workbench``
# after porting its three stream modules (design.md, Collision-Resolution Map
# table C). The TS deliverable checked here is therefore ``apps/frontend``.
PYTHON_SIDECAR_MANIFEST = "services/gateway/pyproject.toml"
RUST_CRATE_MANIFEST = "crates/hardware-probe/Cargo.toml"
TS_FRONTEND_MANIFEST = "apps/frontend/package.json"

# Supporting deliverables named in the design (not part of the R13.1
# three-language completion gate, but expected to exist post-cutover).
SHARED_CONTRACT_DIR = "packages/shared-types"
EVOLUTION_ENGINE_MANIFEST = "python/zocai_evolution/pyproject.toml"


# ---------------------------------------------------------------------------
# R13.1 completion predicate -- "complete only when all three exist"
# ---------------------------------------------------------------------------


def migration_complete(
    *, python_exists: bool, rust_exists: bool, ts_exists: bool
) -> bool:
    """Return whether the migration is complete per R13.1.

    The Migration is considered complete *only when all three* language
    deliverables exist: the Python sidecar AND the Rust crate AND the
    TypeScript frontend. Any single missing deliverable means the migration is
    not complete.
    """
    return python_exists and rust_exists and ts_exists


# ---------------------------------------------------------------------------
# R13.1 -- all three language deliverables exist on disk
# ---------------------------------------------------------------------------


def test_python_sidecar_exists_and_manifest_parses() -> None:
    """The Python FastAPI sidecar exists with a parseable build manifest.

    **Validates: Requirements 13.1**
    """
    manifest = WORKSPACE_ROOT / PYTHON_SIDECAR_MANIFEST
    assert manifest.is_file(), f"missing Python sidecar manifest: {manifest}"

    data = tomllib.loads(manifest.read_text(encoding="utf-8"))
    # A buildable Python project declares either [project] or a [build-system].
    assert "project" in data or "build-system" in data, (
        "services/gateway/pyproject.toml does not declare a buildable project"
    )


def test_rust_crate_exists_and_manifest_parses() -> None:
    """The Rust ``hardware-probe`` crate exists with a parseable Cargo manifest.

    **Validates: Requirements 13.1**
    """
    manifest = WORKSPACE_ROOT / RUST_CRATE_MANIFEST
    assert manifest.is_file(), f"missing Rust crate manifest: {manifest}"

    data = tomllib.loads(manifest.read_text(encoding="utf-8"))
    assert "package" in data, "crates/hardware-probe/Cargo.toml has no [package]"
    assert data["package"].get("name"), "Rust crate manifest declares no package name"


def test_ts_frontend_exists_and_manifest_parses() -> None:
    """The TypeScript/React frontend exists with a parseable package manifest.

    **Validates: Requirements 13.1**
    """
    manifest = WORKSPACE_ROOT / TS_FRONTEND_MANIFEST
    assert manifest.is_file(), f"missing TS frontend manifest: {manifest}"

    data = json.loads(manifest.read_text(encoding="utf-8"))
    assert data.get("name"), "apps/frontend/package.json declares no package name"
    # A buildable frontend exposes a build script.
    assert "build" in data.get("scripts", {}), (
        "apps/frontend/package.json defines no build script"
    )


def test_all_three_language_deliverables_present() -> None:
    """All three deliverables exist together, so the migration is complete.

    This is the affirmative R13.1 end-state: Python + Rust + TS all present.

    **Validates: Requirements 13.1**
    """
    python_exists = (WORKSPACE_ROOT / PYTHON_SIDECAR_MANIFEST).is_file()
    rust_exists = (WORKSPACE_ROOT / RUST_CRATE_MANIFEST).is_file()
    ts_exists = (WORKSPACE_ROOT / TS_FRONTEND_MANIFEST).is_file()

    assert python_exists and rust_exists and ts_exists
    assert migration_complete(
        python_exists=python_exists, rust_exists=rust_exists, ts_exists=ts_exists
    )


def test_supporting_deliverables_present() -> None:
    """The shared Event_Contract and evolution engine also exist post-cutover.

    These are not part of the R13.1 completion gate but are required Ecosystem
    components; their presence confirms the cutover did not orphan them.
    """
    assert (WORKSPACE_ROOT / SHARED_CONTRACT_DIR).is_dir()
    assert (WORKSPACE_ROOT / EVOLUTION_ENGINE_MANIFEST).is_file()


# ---------------------------------------------------------------------------
# R13.1 -- completion requires ALL three (any one missing => incomplete)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("python_exists", "rust_exists", "ts_exists", "expected"),
    [
        (True, True, True, True),
        (False, True, True, False),
        (True, False, True, False),
        (True, True, False, False),
        (True, False, False, False),
        (False, True, False, False),
        (False, False, True, False),
        (False, False, False, False),
    ],
)
def test_migration_complete_only_when_all_three_exist(
    python_exists: bool, rust_exists: bool, ts_exists: bool, expected: bool
) -> None:
    """Migration is complete iff Python AND Rust AND TS all exist (R13.1).

    Every present/absent combination of the three language deliverables is
    enumerated: completion is reported only for the all-present case.

    **Validates: Requirements 13.1**
    """
    assert (
        migration_complete(
            python_exists=python_exists, rust_exists=rust_exists, ts_exists=ts_exists
        )
        is expected
    )


# ---------------------------------------------------------------------------
# R9.1 -- ``.zocai/`` stores are created on first run
# ---------------------------------------------------------------------------


def test_zocai_stores_created_on_first_run(tmp_path: Path) -> None:
    """First MemoryMatrix init creates the ``.zocai/`` tree under the workspace.

    Drives initialization against a pristine temporary workspace (no ``.zocai/``
    present) and asserts the directory and every tier sub-store are created and
    confined under ``<workspace>/.zocai`` (R9.1).

    **Validates: Requirements 9.1**
    """
    matrix = MemoryMatrix(tmp_path)

    # Pristine workspace: nothing exists yet.
    assert not matrix.zocai_dir.exists()
    assert not matrix.is_initialized()

    matrix.initialize()

    # The matrix root and every owned directory now exist...
    assert matrix.zocai_dir.is_dir()
    for directory in matrix.directories():
        assert directory.is_dir(), f"tier directory not created: {directory}"
    # ...along with every tier sub-store file.
    for store in matrix.files():
        assert store.is_file(), f"tier sub-store not created: {store}"
    assert matrix.is_initialized()

    # R9.1 confinement: nothing was created outside the ``.zocai/`` subtree.
    zocai_dir = matrix.zocai_dir.resolve()
    for path in (*matrix.directories(), *matrix.files()):
        resolved = path.resolve()
        assert resolved == zocai_dir or zocai_dir in resolved.parents, (
            f"store escaped .zocai/ confinement: {resolved}"
        )


def test_zocai_initialization_is_idempotent(tmp_path: Path) -> None:
    """Re-initializing a populated ``.zocai/`` preserves existing store content.

    The "create on first run" guarantee must not clobber retained history on a
    second run (R9.1/R9.2 idempotence).
    """
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    # Write recognizable content into the append-only diary.
    matrix.session_diary_path.write_text('{"seq": 0}\n', encoding="utf-8")

    # A second initialization must not truncate or overwrite it.
    matrix.initialize()

    assert matrix.session_diary_path.read_text(encoding="utf-8") == '{"seq": 0}\n'
    assert matrix.is_initialized()
