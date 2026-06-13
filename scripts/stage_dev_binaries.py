#!/usr/bin/env python3
"""Stage the Tauri ``externalBin`` sidecars for local development.

``tauri dev`` evaluates ``tauri.conf.json`` before launching and aborts with
"resource path ... doesn't exist" if the binaries declared under
``externalBin`` are missing. Those entries follow the
``<name>-<rust-target-triple>`` naming convention and live in
``apps/desktop/binaries/``.

This script provisions both required binaries for the host triple:

* ``llama-studio-hotpath`` — built from the ``hotpath`` crate via cargo.
* ``llama-studio-agent``   — bundled from the FastAPI sidecar via PyInstaller
  (delegated to ``bundle_sidecar.py``).

It is idempotent: if a binary already exists it is left untouched so repeated
``make dev`` runs stay fast. The check is existence-based, not freshness-based,
so after changing sidecar/hotpath source you must delete the staged file (or run
``make clean``) to force a rebuild. Missing toolchains (cargo / PyInstaller)
produce a clear warning and a non-zero exit instead of a cryptic Tauri error.
"""

from __future__ import annotations

import contextlib
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from bundle_sidecar import _detect_triple  # reuse triple detection

ROOT = Path(__file__).resolve().parent.parent
BIN_OUT = ROOT / "apps" / "desktop" / "binaries"
HOTPATH_CRATE = "llama-studio-hotpath"


def _exe_suffix() -> str:
    return ".exe" if platform.system().lower() == "windows" else ""


def _stage_hotpath(triple: str) -> int:
    suffix = _exe_suffix()
    target = BIN_OUT / f"{HOTPATH_CRATE}-{triple}{suffix}"
    if target.exists():
        print(f"==> hotpath already staged: {target.relative_to(ROOT)}")
        return 0

    if shutil.which("cargo") is None:
        print(
            "!! cargo not found — cannot build the hotpath binary. Install the "
            "Rust toolchain (https://rustup.rs).",
            file=sys.stderr,
        )
        return 1

    print(f"==> Building {HOTPATH_CRATE} (release)")
    subprocess.check_call(
        ["cargo", "build", "--release", "-p", HOTPATH_CRATE], cwd=str(ROOT)
    )

    produced = ROOT / "target" / "release" / f"{HOTPATH_CRATE}{suffix}"
    if not produced.exists():
        print(f"!! cargo did not produce {produced}", file=sys.stderr)
        return 2

    shutil.copy2(produced, target)
    with contextlib.suppress(OSError):
        target.chmod(0o755)
    print(f"==> hotpath staged: {target.relative_to(ROOT)}")
    return 0


def _stage_agent(triple: str) -> int:
    suffix = _exe_suffix()
    target = BIN_OUT / f"llama-studio-agent-{triple}{suffix}"
    if target.exists():
        print(f"==> agent sidecar already staged: {target.relative_to(ROOT)}")
        return 0

    print("==> Bundling agent sidecar (PyInstaller)")
    return subprocess.call([sys.executable, str(ROOT / "scripts" / "bundle_sidecar.py")])


def main() -> int:
    triple = _detect_triple()
    print(f"==> Staging dev binaries for target {triple}")
    BIN_OUT.mkdir(parents=True, exist_ok=True)

    rc = _stage_hotpath(triple)
    if rc != 0:
        return rc
    return _stage_agent(triple)


if __name__ == "__main__":
    raise SystemExit(main())
