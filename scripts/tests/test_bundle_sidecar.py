"""Guard for the Agent_Runtime bundling target — zoc-agent-chat-rebuild R3.9, R4.3.

Covers the two facts the packaged build depends on and nothing else:

- the target triple is resolved from ``rustc --print host-tuple``, because that
  is the string Tauri expects as the ``externalBin`` filename suffix, and
- every ``externalBin`` entry in ``tauri.conf.json`` names a binary the bundler
  writes under ``<name>-<triple><ext>``.

The `pkg` pass itself is not exercised here: it downloads a patched Node base
binary and takes minutes, so it is verified by running the bundler, which is
what `scripts/bundle_sidecar.py --target runtime` is for.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import bundle_sidecar  # noqa: E402


def test_explicit_triple_wins(monkeypatch) -> None:
    monkeypatch.setenv("ZOC_STUDIO_TARGET_TRIPLE", "aarch64-apple-darwin")
    assert bundle_sidecar._detect_triple() == "aarch64-apple-darwin"


def test_triple_comes_from_rustc_print_host_tuple(monkeypatch) -> None:
    monkeypatch.delenv("ZOC_STUDIO_TARGET_TRIPLE", raising=False)
    calls: list[list[str]] = []

    def fake_check_output(cmd, **kwargs):  # noqa: ANN001, ANN202
        calls.append(list(cmd))
        if cmd[:3] == ["rustc", "--print", "host-tuple"]:
            return "x86_64-unknown-linux-gnu\n"
        raise AssertionError(f"unexpected fallback to {cmd}")

    monkeypatch.setattr(bundle_sidecar.subprocess, "check_output", fake_check_output)
    assert bundle_sidecar._detect_triple() == "x86_64-unknown-linux-gnu"
    assert calls == [["rustc", "--print", "host-tuple"]]


def test_falls_back_to_rustc_vv_on_an_older_toolchain(monkeypatch) -> None:
    # `--print host-tuple` is recent; a toolchain without it must still resolve
    # rather than drop to the platform heuristic, which cannot distinguish gnu
    # from musl.
    monkeypatch.delenv("ZOC_STUDIO_TARGET_TRIPLE", raising=False)

    def fake_check_output(cmd, **kwargs):  # noqa: ANN001, ANN202
        if cmd[:3] == ["rustc", "--print", "host-tuple"]:
            raise subprocess.CalledProcessError(1, cmd)
        if cmd == ["rustc", "-vV"]:
            return "rustc 1.80.0\nhost: aarch64-unknown-linux-gnu\n"
        raise AssertionError(f"unexpected command {cmd}")

    monkeypatch.setattr(bundle_sidecar.subprocess, "check_output", fake_check_output)
    assert bundle_sidecar._detect_triple() == "aarch64-unknown-linux-gnu"


def test_every_external_bin_is_produced_under_the_triple_suffixed_name() -> None:
    config = json.loads((REPO_ROOT / "apps" / "desktop" / "tauri.conf.json").read_text())
    entries = config["bundle"]["externalBin"]

    # R3.9: the Agent_Runtime rides alongside the gateway and hotpath entries.
    assert "binaries/zoc-studio-agent-runtime" in entries
    assert "binaries/zoc-studio-agent" in entries
    assert "binaries/zoc-studio-hotpath" in entries

    triple = bundle_sidecar._detect_triple()
    suffix = ".exe" if triple.endswith("windows-msvc") else ""
    for entry in entries:
        name = entry.split("/")[-1]
        produced = bundle_sidecar.BIN_OUT / f"{name}-{triple}{suffix}"
        assert produced.is_file(), f"{produced} is missing; run pnpm sidecar:bundle"


def test_every_pkg_target_maps_a_real_rust_triple() -> None:
    # A typo on either side of this map is a bundler that silently emits nothing
    # for a platform, so both halves are shape-checked.
    for triple, pkg_target in bundle_sidecar.PKG_TARGETS.items():
        assert triple.count("-") >= 2, triple
        assert pkg_target.startswith("node20-"), pkg_target
    assert bundle_sidecar.PKG_TARGETS[bundle_sidecar._detect_triple()]


def test_the_smoke_test_asserts_the_supervisors_handshake_prefix() -> None:
    # The supervisor greps for this exact prefix; a bundler that smoke-tests a
    # different one would pass on a binary the supervisor cannot start.
    sidecar_rs = (REPO_ROOT / "apps" / "desktop" / "src" / "sidecar.rs").read_text()
    assert f'"{bundle_sidecar.RUNTIME_PORT_PREFIX}"' in sidecar_rs
