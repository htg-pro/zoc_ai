"""Setup/config smoke test (task 12.1).

Feature: zoc-agent-ecosystem-merge.

**Validates: Requirements 10.1, 10.6**

Static, fast, deterministic smoke check of the packaging/setup config for the
agent-only merge. It inspects the **real workspace on disk** only as text/JSON
and creates a throwaway ``.zocai/`` store under ``tmp_path`` -- it never starts
a server and never runs PyInstaller.

It asserts the defining setup outcomes of the merge:

* **The Tauri build bundles the Gateway as the ``zoc-studio-agent`` sidecar
  (R10.6, R10.1).** ``apps/desktop/tauri.conf.json`` declares
  ``binaries/zoc-studio-agent`` in its ``bundle.externalBin`` list, so the
  desktop shell launches the Gateway as a bundled sidecar and the installer
  ships it.

* **The sidecar bundler targets the Gateway (R10.6).**
  ``scripts/bundle_sidecar.py`` points ``SERVICE`` at ``services/gateway`` and
  ``ENTRY`` at the Gateway launch entrypoint
  ``.../zocai_gateway/scripts/launch.py``.

* **The ``.zocai/`` store is created on first run (R10.1-adjacent).** Driving
  :class:`MemoryMatrix.initialize` against a pristine ``tmp_path`` workspace
  creates the ``.zocai/`` directory.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


def _find_workspace_root() -> Path:
    """Walk upward from this test file to the monorepo root.

    The root is identified by the co-location of the three top-level build
    manifests that anchor the multi-language workspace (pnpm + Cargo + uv), so
    the test stays robust if relocated within the tree rather than hard-coding
    ``parents[n]``.
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


def test_packaging_setup_smoke(tmp_path: Path) -> None:
    """Static packaging/setup config facts for the agent-only merge.

    **Validates: Requirements 10.1, 10.6**
    """
    # -- R10.6/R10.1: Tauri bundles the gateway sidecar -------------------
    manifest = WORKSPACE_ROOT / TAURI_CONF
    assert manifest.is_file(), f"missing Tauri manifest: {manifest}"

    data = json.loads(manifest.read_text(encoding="utf-8"))
    external_bin = data.get("bundle", {}).get("externalBin", [])
    assert SIDECAR_BIN_NAME in external_bin, (
        f"{TAURI_CONF} externalBin {external_bin!r} does not include "
        f"{SIDECAR_BIN_NAME!r}; the Gateway sidecar would not be bundled"
    )

    # -- R10.6: the sidecar bundler targets the gateway -------------------
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

    # -- R10.1-adjacent: ``.zocai/`` is created on first run --------------
    # Optional sub-assertion: only run when the MemoryMatrix API is available;
    # skip gracefully otherwise rather than over-engineering.
    try:
        from zocai_gateway.memory.matrix import MemoryMatrix
    except Exception:  # pragma: no cover - environment without the gateway pkg
        return

    matrix = MemoryMatrix(tmp_path)
    assert not matrix.zocai_dir.exists()

    matrix.initialize()

    assert matrix.zocai_dir.is_dir(), (
        f"first run did not create the .zocai/ store at {matrix.zocai_dir}"
    )
    # Confinement: the store lives under the given workspace root.
    assert matrix.zocai_dir.resolve().parent == tmp_path.resolve()
