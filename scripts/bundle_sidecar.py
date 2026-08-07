#!/usr/bin/env python3
"""Bundle the FastAPI agent sidecar into a single-file executable.

Uses PyInstaller to produce ``zoc-studio-agent`` (or ``.exe`` on Windows)
and copies it into ``apps/desktop/binaries/`` under the Tauri ``externalBin``
naming convention: ``<name>-<rust-target-triple>``.

Falls back to a no-op shim warning if PyInstaller is unavailable.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICE = ROOT / "services" / "gateway"
DIST = ROOT / "dist" / "sidecar"
BIN_OUT = ROOT / "apps" / "desktop" / "binaries"
ENTRY = SERVICE / "src" / "zocai_gateway" / "scripts" / "launch.py"

# ── Agent_Runtime (Node) target — zoc-agent-chat-rebuild R3.9, R4.3 ────────
RUNTIME_PKG = ROOT / "apps" / "agent-runtime"
RUNTIME_BUNDLE = RUNTIME_PKG / "dist" / "agent-runtime.cjs"
RUNTIME_NAME = "zoc-studio-agent-runtime"

#: The handshake line `AgentRuntimeSupervisor` greps for (R3.2). Kept here as a
#: constant so the smoke test asserts the same prefix the supervisor parses.
RUNTIME_PORT_PREFIX = "ZOC_RUNTIME_PORT="

#: `pkg` target strings keyed by rust target triple. Only the host's entry is
#: built by default; the full map is here because `pkg` can emit all three from
#: one host, which is the reason it was chosen over a Node SEA build.
PKG_TARGETS = {
    "x86_64-unknown-linux-gnu": "node20-linux-x64",
    "aarch64-unknown-linux-gnu": "node20-linux-arm64",
    "x86_64-apple-darwin": "node20-macos-x64",
    "aarch64-apple-darwin": "node20-macos-arm64",
    "x86_64-pc-windows-msvc": "node20-win-x64",
    "aarch64-pc-windows-msvc": "node20-win-arm64",
}


def _detect_triple() -> str:
    """Resolve the Rust target triple Tauri names its `externalBin` files after.

    ``rustc --print host-tuple`` first, because that is the command Tauri's own
    Node-sidecar guide documents and the one whose output *is* the filename
    suffix. ``rustc -vV``'s ``host:`` line is the fallback for toolchains
    predating the print request, and the platform heuristic is the last resort
    for a machine with no rustc on PATH at all.
    """
    explicit = os.environ.get("ZOC_STUDIO_TARGET_TRIPLE")
    if explicit:
        return explicit
    return _host_triple()


def _host_triple() -> str:
    """The triple of the machine running this script, ignoring any override.

    Separate from `_detect_triple` so the smoke test can ask "can this host
    execute what we just built?" — a question the override must not be able to
    answer yes to for a cross-built target.
    """
    try:
        out = subprocess.check_output(
            ["rustc", "--print", "host-tuple"], text=True, stderr=subprocess.DEVNULL
        ).strip()
        if out:
            return out.splitlines()[0].strip()
    except (OSError, subprocess.CalledProcessError):
        pass
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


def bundle_agent_runtime(triple: str) -> int:
    """Bundle the Node Agent_Runtime into an `externalBin` executable (R3.9).

    Two passes, both required:

      1. ``esbuild`` collapses ``src/main.ts``'s module graph — entered through
         the three-line ``src/bin.ts`` — into one CommonJS file, and asserts the
         result carries no dynamic ``require``.
      2. ``@yao-pkg/pkg`` embeds a Node runtime around that file, so the packaged
         app needs no user-installed toolchain.

    The ``@yao-pkg`` fork is pinned deliberately: ``vercel/pkg`` is unmaintained
    at 5.8.1 and carries no Node 20+ base binary.
    """
    print(f"==> Bundling Agent_Runtime for target {triple}")
    if not RUNTIME_PKG.exists():
        print(f"!! {RUNTIME_PKG} is missing", file=sys.stderr)
        return 2

    pnpm = shutil.which("pnpm")
    if pnpm is None:
        print("!! pnpm not found — cannot bundle the Node runtime.", file=sys.stderr)
        return 1

    # Pass 1: esbuild.
    try:
        subprocess.check_call(
            [pnpm, "exec", "node", "./scripts/bundle.mjs"],
            cwd=str(RUNTIME_PKG),
            timeout=300,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print(f"!! esbuild pass failed: {exc}", file=sys.stderr)
        return 1
    if not RUNTIME_BUNDLE.exists():
        print(f"!! esbuild did not produce {RUNTIME_BUNDLE}", file=sys.stderr)
        return 2

    pkg_target = PKG_TARGETS.get(triple)
    if pkg_target is None:
        print(
            f"!! no @yao-pkg/pkg target mapped for {triple}; add it to PKG_TARGETS.",
            file=sys.stderr,
        )
        return 2

    suffix = ".exe" if triple.endswith("windows-msvc") else ""
    staged = BIN_OUT / f"{RUNTIME_NAME}-{triple}{suffix}"
    BIN_OUT.mkdir(parents=True, exist_ok=True)

    # Pass 2: pkg. Emit straight to the Tauri `externalBin` path layout —
    # `<name>-<target-triple><ext>` — which is what Tauri documents for a Node
    # sidecar and the reason no rename step is needed afterwards.
    produced = RUNTIME_PKG / "dist" / f"{RUNTIME_NAME}{suffix}"
    try:
        subprocess.check_call(
            [
                pnpm,
                "exec",
                "pkg",
                str(RUNTIME_BUNDLE),
                "--target",
                pkg_target,
                "--output",
                str(produced),
                "--public",
            ],
            cwd=str(RUNTIME_PKG),
            timeout=900,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        print(f"!! pkg pass failed: {exc}", file=sys.stderr)
        return 1

    if not produced.exists():
        print(f"!! pkg did not produce {produced}", file=sys.stderr)
        return 2

    tmp_target = staged.with_name(f".{staged.name}.tmp")
    shutil.copy2(produced, tmp_target)
    os.replace(tmp_target, staged)
    with contextlib.suppress(OSError):
        staged.chmod(0o755)
    print(f"==> Agent_Runtime written to {staged.relative_to(ROOT)}")

    # Smoke test, same intent as the Python sidecar's `--help` above: a binary
    # that cannot announce its port is useless to the supervisor, and finding
    # that out here costs seconds where finding it out from a packaged app costs
    # a release. Cross-built targets are skipped — a linux host cannot run a
    # windows or macOS executable.
    if triple == _host_triple():
        rc = smoke_test_runtime(staged)
        if rc != 0:
            return rc
    else:
        print(f"==> Skipping smoke test: {triple} is not runnable on this host")
    return 0


def smoke_test_runtime(binary: Path) -> int:
    """Start the packaged runtime and require the `ZOC_RUNTIME_PORT=` line (R3.2).

    The three launch variables mirror what `AgentRuntimeSupervisor` passes, so a
    binary that starts here starts under the supervisor for the same reasons.
    """
    env = dict(os.environ)
    env["ZOC_RUNTIME_TOKEN"] = "smoke-test-token"
    # Port 0 is deliberate: nothing is listening there, and the runtime is
    # written to tolerate a Workspace_Services that is not up yet.
    env["ZOC_WORKSPACE_SERVICES_URL"] = "http://127.0.0.1:0"
    env["ZOC_STUDIO_WORKSPACE"] = str(ROOT)

    proc = subprocess.Popen(
        [str(binary)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        deadline = time.monotonic() + 30
        announced: str | None = None
        assert proc.stdout is not None
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if line == "":
                break
            line = line.strip()
            print(f"    [runtime] {line}")
            if line.startswith(RUNTIME_PORT_PREFIX):
                announced = line
                break
        if announced is None:
            stderr = ""
            if proc.stderr is not None:
                with contextlib.suppress(Exception):
                    stderr = proc.stderr.read()[:2000]
            print(
                f"!! Agent_Runtime smoke test failed: no {RUNTIME_PORT_PREFIX}<n> line.\n"
                f"!! stderr: {stderr}",
                file=sys.stderr,
            )
            return 1
        port = announced[len(RUNTIME_PORT_PREFIX) :].strip()
        if not port.isdigit() or int(port) <= 0:
            print(
                f"!! Agent_Runtime announced an unusable port: `{announced}`",
                file=sys.stderr,
            )
            return 1
        print(f"==> Agent_Runtime smoke test passed ({announced})")
        return 0
    finally:
        proc.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=10)
        if proc.poll() is None:
            proc.kill()
        for pipe in (proc.stdout, proc.stderr):
            if pipe is not None:
                with contextlib.suppress(Exception):
                    pipe.close()


def bundle_python_sidecar(args: argparse.Namespace, triple: str) -> int:
    print(f"==> Bundling sidecar for target {triple}")

    DIST.mkdir(parents=True, exist_ok=True)
    BIN_OUT.mkdir(parents=True, exist_ok=True)
    work = DIST / "build"
    out = DIST / "dist"
    spec = DIST / "zoc-studio-agent.spec"
    if args.clean:
        print("==> Cleaning PyInstaller cache (work/dist/spec) for a fresh build")
        for p in (work, out):
            shutil.rmtree(p, ignore_errors=True)
        with contextlib.suppress(OSError):
            spec.unlink()

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
    if importlib.util.find_spec("httpx") is None:
        print(
            "!! httpx is not installed. It is a Gateway runtime dependency; "
            "bundle with `uv run --package zocai-gateway --with pyinstaller "
            "python3 scripts/bundle_sidecar.py` or install gateway dependencies.",
            file=sys.stderr,
        )
        return 1

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--onefile",
    ]
    if args.clean:
        # Clear PyInstaller's own caches (PYINSTALLER_CONFIG_DIR, __pycache__)
        # in addition to our work/dist dirs, so no stale analysis survives.
        cmd.append("--clean")
    cmd += [
        "--name",
        "zoc-studio-agent",
        "--paths",
        str(SERVICE / "src"),
        "--paths",
        str(ROOT / "services"),
        "--paths",
        str(ROOT / "python" / "zocai_evolution" / "src"),
        "--paths",
        str(ROOT / "packages" / "shared-types" / "python"),
        "--collect-submodules",
        "zocai_gateway",
        "--collect-submodules",
        "mcp_servers",
        "--collect-submodules",
        "zocai_evolution",
        "--collect-submodules",
        "shared_schema",
        "--collect-submodules",
        "httpx",
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
    produced = out / f"zoc-studio-agent{suffix}"
    if not produced.exists():
        print(f"!! PyInstaller did not produce {produced}", file=sys.stderr)
        return 2

    target = BIN_OUT / f"zoc-studio-agent-{triple}{suffix}"
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
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    # Clean by default: a stale PyInstaller cache is the #1 cause of a packaged
    # app shipping old backend code after a source change. Pass --no-clean only
    # when you knowingly want a faster, possibly-stale incremental build.
    parser.add_argument(
        "--clean",
        dest="clean",
        action="store_true",
        help="(default) wipe the PyInstaller build cache before bundling",
    )
    parser.add_argument(
        "--no-clean",
        dest="clean",
        action="store_false",
        help="reuse the PyInstaller build cache (faster, may ship stale code)",
    )
    parser.add_argument(
        "--target",
        choices=("all", "python", "runtime"),
        default="all",
        help="which sidecar to bundle (default: all)",
    )
    parser.set_defaults(clean=True)
    args = parser.parse_args()

    triple = _detect_triple()

    if args.target in ("all", "python"):
        rc = bundle_python_sidecar(args, triple)
        if rc != 0:
            return rc

    if args.target in ("all", "runtime"):
        rc = bundle_agent_runtime(triple)
        if rc != 0:
            return rc

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
