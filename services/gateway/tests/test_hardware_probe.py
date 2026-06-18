"""Unit tests for the Python hardware probe (task 3.2, R1.2, R1.6).

These example-based tests cover the contract that matters to the
``Model_Allocator``:

* the module imports cleanly without the compiled PyO3 extension present;
* a real probe on the test host produces a usable profile; and
* probing failure yields ``None`` so the allocator takes the deterministic
  Local SLM fallback (R1.6).

The exhaustive property-based checks for tier selection live in later tasks.
"""

from __future__ import annotations

import pytest

import zocai_gateway.hardware_probe as hp
from zocai_gateway.hardware_probe import HardwareProfile, probe


def test_module_imports_without_native_extension() -> None:
    # The pure-Python path must work even though the PyO3 binding is not built.
    import importlib.util

    assert importlib.util.find_spec(hp._NATIVE_MODULE_NAME) is None
    # Importing and calling must still succeed (degrade gracefully).
    assert probe.__module__ == "zocai_gateway.hardware_probe"


def test_probe_on_test_host_returns_usable_profile() -> None:
    # Any real CI/dev host has detectable, positive system memory, so the
    # probe returns a non-None profile with a usable system-memory reading.
    profile = probe()
    assert profile is not None
    assert profile.system_memory_gb is not None
    assert profile.system_memory_gb > 0.0


def test_probe_returns_none_when_all_detection_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    # R1.6: when nothing can be probed (no native binding, no system memory,
    # no GPU), probe() returns None to deterministically trigger the Local SLM
    # fallback in the allocator.
    monkeypatch.setattr(hp, "_probe_via_native", lambda: None)
    monkeypatch.setattr(hp, "_detect_system_memory_gb", lambda: None)
    monkeypatch.setattr(hp, "_detect_gpu_memory_gb", lambda: None)
    assert probe() is None


def test_native_probe_used_when_available(monkeypatch: pytest.MonkeyPatch) -> None:
    # When the native binding reports a usable profile, it is returned without
    # consulting the pure-Python path.
    native_profile = HardwareProfile(gpu_memory_gb=12.0, system_memory_gb=32.0)
    monkeypatch.setattr(hp, "_probe_via_native", lambda: native_profile)

    def _fail() -> float | None:
        raise AssertionError("pure-Python detection should not be reached")

    monkeypatch.setattr(hp, "_detect_system_memory_gb", _fail)
    monkeypatch.setattr(hp, "_detect_gpu_memory_gb", _fail)
    assert probe() is native_profile


def test_empty_native_profile_falls_back_to_python(monkeypatch: pytest.MonkeyPatch) -> None:
    # An empty native profile (nothing detected) must not short-circuit the
    # pure-Python fallback.
    monkeypatch.setattr(hp, "_probe_via_native", lambda: HardwareProfile())
    monkeypatch.setattr(hp, "_detect_system_memory_gb", lambda: 16.0)
    monkeypatch.setattr(hp, "_detect_gpu_memory_gb", lambda: None)
    result = probe()
    assert result == HardwareProfile(gpu_memory_gb=None, system_memory_gb=16.0)


def test_partial_profile_is_usable_when_only_system_memory_detected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hp, "_probe_via_native", lambda: None)
    monkeypatch.setattr(hp, "_detect_system_memory_gb", lambda: 8.0)
    monkeypatch.setattr(hp, "_detect_gpu_memory_gb", lambda: None)
    result = probe()
    assert result is not None
    assert result.system_memory_gb == 8.0
    assert result.gpu_memory_gb is None
    assert not result.is_empty


def test_coerce_gb_rejects_invalid_values() -> None:
    # Bad native readings degrade to "undetected" rather than corrupting state.
    assert hp._coerce_gb(None) is None
    assert hp._coerce_gb(True) is None
    assert hp._coerce_gb("32") is None
    assert hp._coerce_gb(0.0) is None
    assert hp._coerce_gb(-4.0) is None
    assert hp._coerce_gb(float("inf")) is None
    assert hp._coerce_gb(float("nan")) is None
    assert hp._coerce_gb(16) == 16.0
    assert hp._coerce_gb(12.5) == 12.5
