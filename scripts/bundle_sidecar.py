#!/usr/bin/env python3
"""Bundle the FastAPI agent sidecar into a single-file executable.

Uses PyInstaller to produce ``llama-studio-agent`` (or ``.exe`` on Windows)
and copies it into ``apps/desktop/binaries/`` under the Tauri ``externalBin``
naming convention: ``<name>-<rust-target-triple>``.

Falls back to a no-op shim warning if PyInstaller is unavailable.
"""
from __future__ import annotations

import argparse
import contextlib
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICE = ROOT / "services" / "agent"
DIST = ROOT / "dist" / "sidecar"
BIN_OUT = ROOT / "apps" / "desktop" / "binaries"
ENTRY = SERVICE / "src" / "llama_studio_agent" / "scripts" / "launch.py"


def _detect_triple() -> str:
    explicit = os.environ.get("LLAMA_STUDIO_TARGET_TRIPLE")
    if explicit:
        return explicit
    try:
        out = subprocess.check_output(["rustc", "-vV"], text=True)
        for line in out.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    # Heuristic fallback
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = {"x86_64": "x86_64", "amd64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(
        machine, machine
    )
    if system == "linux":
        return f"{arch}-unknown-linux-gnu"
    if system == "darwin":
        return f"{arch}-apple-darwin"
    if system == "windows":
        return f"{arch}-pc-windows-msvc"
    return f"{arch}-unknown-{system}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()

    triple = _detect_triple()
    print(f"==> Bundling sidecar for target {triple}")

    DIST.mkdir(parents=True, exist_ok=True)
    BIN_OUT.mkdir(parents=True, exist_ok=True)
    work = DIST / "build"
    out = DIST / "dist"
    if args.clean:
        for p in (work, out):
            shutil.rmtree(p, ignore_errors=True)

    try:
        import PyInstaller.__main__  # noqa: F401
    except ImportError:
        print(
            "!! PyInstaller is not installed. Install with: "
            "uv pip install pyinstaller (or pip install pyinstaller).\n"
            "!! Skipping sidecar bundling — Tauri build will fail without the binary.",
            file=sys.stderr,
        )
        return 1

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--name",
        "llama-studio-agent",
        "--paths",
        str(SERVICE / "src"),
        "--paths",
        str(ROOT / "packages" / "shared-types" / "python"),
        "--collect-submodules",
        "llama_studio_agent",
        "--collect-submodules",
        "shared_schema",
        "--hidden-import",
        "uvicorn.logging",
        "--hidden-import",
        "uvicorn.loops.auto",
        "--hidden-import",
        "uvicorn.protocols.http.auto",
        "--hidden-import",
        "uvicorn.protocols.websockets.auto",
        "--hidden-import",
        "uvicorn.lifespan.on",
        "--workpath",
        str(work),
        "--distpath",
        str(out),
        "--specpath",
        str(DIST),
        str(ENTRY),
    ]
    print("==> " + " ".join(cmd))
    # PyInstaller can hang on a slow disk or a deadlocked dependency probe.
    # 10 minutes is generous for a fresh build but bounded — CI fails loud
    # instead of burning a runner.
    subprocess.check_call(cmd, timeout=600)

    suffix = ".exe" if platform.system().lower() == "windows" else ""
    produced = out / f"llama-studio-agent{suffix}"
    if not produced.exists():
        print(f"!! PyInstaller did not produce {produced}", file=sys.stderr)
        return 2

    target = BIN_OUT / f"llama-studio-agent-{triple}{suffix}"
    tmp_target = target.with_name(f".{target.name}.tmp")
    shutil.copy2(produced, tmp_target)
    os.replace(tmp_target, target)
    with contextlib.suppress(OSError):
        target.chmod(0o755)
    print(f"==> Sidecar written to {target.relative_to(ROOT)}")

    # Quick smoke test
    try:
        subprocess.check_call([str(target), "--help"], timeout=10)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        print(f"!! Sidecar smoke test failed: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
