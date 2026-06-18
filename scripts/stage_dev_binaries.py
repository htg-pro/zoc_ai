#!/usr/bin/env python3
"""Stage the Tauri ``externalBin`` sidecars for local development.

``tauri dev`` evaluates ``tauri.conf.json`` before launching and aborts with
"resource path ... doesn't exist" if the binaries declared under
``externalBin`` are missing. Those entries follow the
``<name>-<rust-target-triple>`` naming convention and live in
``apps/desktop/binaries/``.

This script provisions both required binaries for the host triple:

* ``zoc-studio-hotpath`` — built from the ``hotpath`` crate via cargo.
* ``zoc-studio-agent``   — bundled from the FastAPI sidecar via PyInstaller
  (delegated to ``bundle_sidecar.py``).

It is **freshness-aware**: a staged binary is rebuilt whenever its source tree
is newer than the staged file (or the file is missing). This means editing the
sidecar (``services/agent``) or hotpath (``crates/hotpath``) source and re-running
``make dev`` picks up your changes automatically — no more stale binaries.
Missing toolchains (cargo / PyInstaller) produce a clear warning and a non-zero
exit instead of a cryptic Tauri error.
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
HOTPATH_CRATE = "zoc-studio-hotpath"
HOTPATH_SRC = ROOT / "crates" / "hotpath"
AGENT_SRC = ROOT / "services" / "agent" / "src"
SHARED_SRC = ROOT / "packages" / "shared-types" / "python"


def _exe_suffix() -> str:
    return ".exe" if platform.system().lower() == "windows" else ""


def _newest_mtime(*roots: Path) -> float:
    """Newest modification time across the given files/directories (0 if none)."""
    newest = 0.0
    for root in roots:
        if not root.exists():
            continue
        if root.is_file():
            with contextlib.suppress(OSError):
                newest = max(newest, root.stat().st_mtime)
            continue
        for p in root.rglob("*"):
            if p.is_file() and "__pycache__" not in p.parts:
                with contextlib.suppress(OSError):
                    newest = max(newest, p.stat().st_mtime)
    return newest


def _is_stale(target: Path, *source_roots: Path) -> bool:
    """True if the staged binary is missing or older than any source file."""
    if not target.exists():
        return True
    try:
        target_mtime = target.stat().st_mtime
    except OSError:
        return True
    return _newest_mtime(*source_roots) > target_mtime


def _stage_hotpath(triple: str) -> int:
    suffix = _exe_suffix()
    target = BIN_OUT / f"{HOTPATH_CRATE}-{triple}{suffix}"
    if not _is_stale(target, HOTPATH_SRC / "src", HOTPATH_SRC / "Cargo.toml"):
        print(f"==> hotpath up to date: {target.relative_to(ROOT)}")
        return 0

    if shutil.which("cargo") is None:
        print(
            "!! cargo not found — cannot build the hotpath binary. Install the "
            "Rust toolchain (https://rustup.rs).",
            file=sys.stderr,
        )
        return 1

    print(f"==> Building {HOTPATH_CRATE} (source changed or missing)")
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
    target = BIN_OUT / f"zoc-studio-agent-{triple}{suffix}"
    if not _is_stale(target, AGENT_SRC, SHARED_SRC):
        print(f"==> agent sidecar up to date: {target.relative_to(ROOT)}")
        return 0

    print("==> Bundling agent sidecar (source changed or missing)")
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
