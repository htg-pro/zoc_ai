"""Final setup/config smoke tests (task 12.1).

Feature: zoc-agent-ecosystem-merge.

**Validates: Requirements 10.1, 10.6**

This is the end-state setup/config smoke test for the agent-only merge. It
inspects the **real workspace on disk** and asserts the two defining setup
outcomes of the merge:

* **Installer/build bundles the Gateway as the ``zoc-studio-agent`` sidecar
  (R10.1, R10.6).** The Tauri desktop manifest must declare
  ``binaries/zoc-studio-agent`` in its ``externalBin`` list, and the sidecar
  bundler (``scripts/bundle_sidecar.py``) must be pointed at the Gateway:
  ``SERVICE`` resolves to ``services/gateway``, ``ENTRY`` to the Gateway launch
  entrypoint ``.../zocai_gateway/scripts/launch.py``, and PyInstaller is told to
  ``--collect-submodules zocai_gateway``. These checks are *manifest/text*
  based (parse ``tauri.conf.json`` as JSON, scan ``bundle_sidecar.py`` as text)
  so the smoke test stays fast and deterministic and never runs PyInstaller.

* **The ``.zocai/`` stores are created on first run (R10.6 +
  ``.zocai`` creation).** We drive :class:`MemoryMatrix.initialize` against a
  pristine throwaway ``tmp_path`` workspace (mirroring the existing check in
  ``python/zocai_migration/tests/test_smoke_three_language_deliverables.py``)
  and assert the ``.zocai/`` tree springs into existence, confined under that
  workspace root.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

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

TAURI_CONF = "apps/desktop/tauri.conf.json"
BUNDLE_SIDECAR_SCRIPT = "scripts/bundle_sidecar.py"
SIDECAR_BIN_NAME = "binaries/zoc-studio-agent"


# ---------------------------------------------------------------------------
# R10.1 / R10.6 -- installer/build bundles the Gateway as the sidecar
# ---------------------------------------------------------------------------


def test_tauri_external_bin_includes_gateway_sidecar() -> None:
    """The Tauri manifest declares ``binaries/zoc-studio-agent`` as a sidecar.

    The Gateway ships as the ``zoc-studio-agent`` external binary so the desktop
    shell launches it as a bundled sidecar (R10.1) and the installer bundles it
    (R10.6).

    **Validates: Requirements 10.1, 10.6**
    """
    manifest = WORKSPACE_ROOT / TAURI_CONF
    assert manifest.is_file(), f"missing Tauri manifest: {manifest}"

    data = json.loads(manifest.read_text(encoding="utf-8"))
    external_bin = data.get("bundle", {}).get("externalBin", [])
    assert SIDECAR_BIN_NAME in external_bin, (
        f"{TAURI_CONF} externalBin {external_bin!r} does not include "
        f"{SIDECAR_BIN_NAME!r}; the Gateway sidecar would not be bundled"
    )


def test_bundle_sidecar_points_at_gateway() -> None:
    """``bundle_sidecar.py`` bundles the Gateway, not the legacy agent.

    Asserts the bundler is pointed at the Gateway service and its launch
    entrypoint, and collects the Gateway package so the produced
    ``zoc-studio-agent`` binary actually contains the Gateway (R10.6).

    **Validates: Requirements 10.6**
    """
    script = WORKSPACE_ROOT / BUNDLE_SIDECAR_SCRIPT
    assert script.is_file(), f"missing sidecar bundler: {script}"

    source = script.read_text(encoding="utf-8")

    # SERVICE -> services/gateway
    assert re.search(
        r"""SERVICE\s*=\s*ROOT\s*/\s*["']services["']\s*/\s*["']gateway["']""",
        source,
    ), "bundle_sidecar.py SERVICE is not pointed at services/gateway"

    # ENTRY -> .../zocai_gateway/scripts/launch.py
    assert re.search(
        r"""ENTRY\s*=\s*SERVICE\s*/\s*["']src["']\s*/\s*["']zocai_gateway["']"""
        r"""\s*/\s*["']scripts["']\s*/\s*["']launch\.py["']""",
        source,
    ), "bundle_sidecar.py ENTRY is not the Gateway launch entrypoint"

    # --collect-submodules zocai_gateway (the args land on adjacent list lines)
    assert re.search(
        r"""["']--collect-submodules["']\s*,\s*["']zocai_gateway["']""",
        source,
    ), "bundle_sidecar.py does not --collect-submodules zocai_gateway"

    # The produced binary keeps the zoc-studio-agent name expected by Tauri.
    assert "zoc-studio-agent" in source, (
        "bundle_sidecar.py no longer names the output binary zoc-studio-agent"
    )


# ---------------------------------------------------------------------------
# R10.6 (+ .zocai creation) -- ``.zocai/`` stores created on first run
# ---------------------------------------------------------------------------


def test_zocai_stores_created_on_first_run(tmp_path: Path) -> None:
    """First MemoryMatrix init creates the ``.zocai/`` tree under the workspace.

    Drives initialization against a pristine temporary workspace (no ``.zocai/``
    present) and asserts the directory and every tier sub-store are created and
    confined under ``<workspace>/.zocai``.

    **Validates: Requirements 10.6**
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

    # Confinement: nothing was created outside the ``.zocai/`` subtree.
    zocai_dir = matrix.zocai_dir.resolve()
    for path in (*matrix.directories(), *matrix.files()):
        resolved = path.resolve()
        assert resolved == zocai_dir or zocai_dir in resolved.parents, (
            f"store escaped .zocai/ confinement: {resolved}"
        )
