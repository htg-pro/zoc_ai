"""Python-facing hardware probe for the ``Model_Allocator`` (R1.2, R1.6).

The allocator needs a hardware profile — available GPU memory and system
memory in gigabytes — to select a Model_Tier within its 500 ms budget (R1.2).
That profile is produced by the Rust ``hardware-probe`` crate on the hot path,
exposed to Python through a PyO3 binding when the native extension has been
built. This module is the Python boundary in front of that crate.

It is deliberately resilient and import-safe:

* It **never requires** the compiled PyO3 extension to be present. Importing
  this module always succeeds; if the native module is missing it degrades to
  a pure-Python probe (``psutil`` when installed, otherwise an OS-level memory
  read, with a best-effort GPU scan).
* :func:`probe` returns a :class:`HardwareProfile` when at least one resource
  is detectable, and returns ``None`` when probing fails entirely. A ``None``
  result is the deterministic signal the ``Model_Allocator`` uses to take the
  Local SLM fallback (R1.6).

The shape mirrors the Rust ``HardwareProfile`` exactly: ``gpu_memory_gb`` and
``system_memory_gb`` are each ``float | None``, where ``None`` means "could not
be detected" so a real 0 GB reading is never conflated with "no reading".
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

__all__ = ["HardwareProfile", "probe"]

# Binary gigabyte (1024^3). The OS reports memory and VRAM totals in bytes; we
# convert with the same binary gigabyte the Rust crate and the allocator's tier
# thresholds use, so Python and Rust readings agree.
_BYTES_PER_GB: float = 1_073_741_824.0

# Expected module name of the compiled PyO3 binding around the Rust crate. The
# native extension is built in a later migration stage; until then this import
# is expected to fail and the pure-Python path takes over.
_NATIVE_MODULE_NAME = "zocai_hardware_probe"


@dataclass(slots=True, frozen=True)
class HardwareProfile:
    """Detected hardware resources, mirroring the Rust ``HardwareProfile``.

    A ``None`` field denotes an undetectable resource (not a real 0 GB
    reading). Downstream allocator logic treats a fully absent profile
    (``probe()`` returning ``None``) as the Local SLM fallback trigger (R1.6).
    """

    gpu_memory_gb: float | None = None
    system_memory_gb: float | None = None

    @property
    def is_empty(self) -> bool:
        """True when no resource at all could be detected."""
        return self.gpu_memory_gb is None and self.system_memory_gb is None


@runtime_checkable
class _NativeProfile(Protocol):
    """Structural shape of the object the PyO3 binding's ``probe()`` returns."""

    @property
    def gpu_memory_gb(self) -> float | None: ...

    @property
    def system_memory_gb(self) -> float | None: ...


def probe() -> HardwareProfile | None:
    """Probe the local machine for GPU and system memory.

    Tries the Rust crate via its PyO3 binding first; if the native extension
    is unavailable or raises, falls back to a pure-Python probe. Returns a
    :class:`HardwareProfile` when at least one resource is detectable, or
    ``None`` when probing fails entirely so the ``Model_Allocator`` takes the
    deterministic Local SLM fallback (R1.6).
    """
    native = _probe_via_native()
    if native is not None and not native.is_empty:
        return native
    return _probe_via_python()


def _probe_via_native() -> HardwareProfile | None:
    """Probe using the Rust crate's PyO3 binding, if it is importable.

    Returns ``None`` (rather than raising) whenever the native extension is
    not built, does not expose a ``probe`` callable, or fails at runtime, so
    callers can degrade to the pure-Python path. The import is done lazily
    inside the function precisely so that importing *this* module never
    depends on the compiled extension existing.
    """
    try:
        import importlib

        native = importlib.import_module(_NATIVE_MODULE_NAME)
    except ImportError:
        return None

    probe_fn = getattr(native, "probe", None)
    if not callable(probe_fn):
        return None

    try:
        result = probe_fn()
    except Exception:
        # A failing native probe must not crash the allocator; fall through to
        # the pure-Python path instead.
        return None

    if not isinstance(result, _NativeProfile):
        return None
    return HardwareProfile(
        gpu_memory_gb=_coerce_gb(result.gpu_memory_gb),
        system_memory_gb=_coerce_gb(result.system_memory_gb),
    )


def _probe_via_python() -> HardwareProfile | None:
    """Pure-Python fallback probe.

    Detects system memory (via ``psutil`` when available, otherwise an
    OS-level read) and makes a best-effort GPU memory scan. Returns ``None``
    when nothing at all could be detected, which the allocator maps to the
    Local SLM fallback (R1.6).
    """
    profile = HardwareProfile(
        gpu_memory_gb=_detect_gpu_memory_gb(),
        system_memory_gb=_detect_system_memory_gb(),
    )
    if profile.is_empty:
        return None
    return profile


def _detect_system_memory_gb() -> float | None:
    """Read total physical system memory in GB, or ``None`` if undetectable.

    Prefers ``psutil`` (cross-platform) and falls back to POSIX ``sysconf``.
    Any failure or non-positive reading yields ``None``.
    """
    try:
        import psutil

        total_bytes = int(psutil.virtual_memory().total)
        return _bytes_to_gb(total_bytes)
    except ImportError:
        pass
    except Exception:
        return None

    # POSIX fallback: page size * physical pages. Guarded so non-POSIX hosts
    # (and hosts missing these keys) report ``None`` rather than raising.
    sysconf = getattr(os, "sysconf", None)
    sysconf_names = getattr(os, "sysconf_names", {})
    if callable(sysconf) and "SC_PAGE_SIZE" in sysconf_names and "SC_PHYS_PAGES" in sysconf_names:
        try:
            page_size = sysconf("SC_PAGE_SIZE")
            phys_pages = sysconf("SC_PHYS_PAGES")
        except (ValueError, OSError):
            return None
        if page_size > 0 and phys_pages > 0:
            return _bytes_to_gb(page_size * phys_pages)
    return None


def _detect_gpu_memory_gb() -> float | None:
    """Best-effort GPU memory probe in GB, or ``None`` if undetectable.

    On Linux this mirrors the Rust crate: it reads the DRM sysfs VRAM totals.
    On other platforms, or when no GPU is discoverable, it returns ``None`` so
    the allocator deterministically takes the Local SLM fallback.
    """
    if os.name != "posix":
        return None
    return _gpu_memory_gb_from_drm_sysfs()


def _gpu_memory_gb_from_drm_sysfs() -> float | None:
    """Scan ``/sys/class/drm/card*/device/mem_info_vram_total`` for VRAM total.

    Returns the largest readable VRAM total in GB, or ``None`` when no readable
    total is found (no discrete GPU, or a driver that does not expose the node).
    Connector sub-nodes such as ``card0-DP-1`` are skipped.
    """
    drm_root = "/sys/class/drm"
    try:
        entries = os.listdir(drm_root)
    except OSError:
        return None

    max_bytes = 0
    for name in entries:
        # Match device nodes like ``card0`` while skipping connector sub-nodes
        # (``card0-DP-1``) and non-card entries (``renderD128``).
        if not name.startswith("card") or "-" in name:
            continue
        vram_path = os.path.join(drm_root, name, "device", "mem_info_vram_total")
        try:
            with open(vram_path, encoding="utf-8") as handle:
                contents = handle.read().strip()
        except OSError:
            continue
        try:
            value = int(contents)
        except ValueError:
            continue
        max_bytes = max(max_bytes, value)

    if max_bytes <= 0:
        return None
    return _bytes_to_gb(max_bytes)


def _bytes_to_gb(num_bytes: int) -> float:
    """Convert a byte count to gigabytes using the binary gigabyte."""
    return num_bytes / _BYTES_PER_GB


def _coerce_gb(value: object) -> float | None:
    """Coerce a native reading to a positive finite float, or ``None``.

    The PyO3 binding returns ``Option<f64>`` (``float | None``); this guards
    against ``None``, non-numeric, or non-positive/non-finite values so a bad
    native reading degrades to "undetected" rather than corrupting allocation.
    """
    if value is None or isinstance(value, bool):
        return None
    if not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number <= 0.0 or number != number or number in (float("inf"), float("-inf")):
        return None
    return number
