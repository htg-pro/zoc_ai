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

__all__ = [
    "PROFILE_TIERS",
    "HardwareProfile",
    "HardwareSnapshot",
    "ModelRecommendation",
    "probe",
    "recommend_model",
    "snapshot",
]

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
        import psutil  # type: ignore[import-untyped]

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


# ── Live snapshot for the hardware monitor (§16.2) ───────────────────────────


@dataclass(slots=True, frozen=True)
class HardwareSnapshot:
    """A point-in-time reading of the resources the status bar displays (§16.2).

    Every field is optional-by-``None`` for the same reason as
    :class:`HardwareProfile`: a value we could not read must be distinguishable
    from a real zero, so the UI can hide a gauge instead of drawing "0%".
    """

    cpu_percent: float | None = None
    ram_used_gb: float | None = None
    ram_total_gb: float | None = None
    gpu_vram_used_mb: int | None = None
    gpu_vram_total_mb: int | None = None
    llm_tokens_per_second: float | None = None
    llm_inference_active: bool = False

    def as_payload(self) -> dict[str, object]:
        """Wire form for the SSE stream (camelCase-free, matching §16.2)."""
        return {
            "cpu_percent": self.cpu_percent,
            "ram_used_gb": self.ram_used_gb,
            "ram_total_gb": self.ram_total_gb,
            "gpu_vram_used_mb": self.gpu_vram_used_mb,
            "gpu_vram_total_mb": self.gpu_vram_total_mb,
            "llm_tokens_per_second": self.llm_tokens_per_second,
            "llm_inference_active": self.llm_inference_active,
        }


def snapshot(
    *,
    tokens_per_second: float | None = None,
    inference_active: bool = False,
) -> HardwareSnapshot:
    """Read current CPU / RAM / VRAM utilisation.

    ``tokens_per_second`` and ``inference_active`` are supplied by the caller
    because only the run pipeline knows whether a model is currently generating;
    this module deliberately does not reach into the model runtime.

    Every probe is best-effort: an unreadable resource yields ``None`` rather
    than raising, because a status-bar widget must never be able to fail a
    request.
    """
    cpu = _detect_cpu_percent()
    ram_total = _detect_system_memory_gb()
    ram_used = _detect_used_memory_gb()
    vram_total, vram_used = _detect_vram_mb()
    return HardwareSnapshot(
        cpu_percent=cpu,
        ram_used_gb=ram_used,
        ram_total_gb=ram_total,
        gpu_vram_used_mb=vram_used,
        gpu_vram_total_mb=vram_total,
        llm_tokens_per_second=tokens_per_second,
        llm_inference_active=inference_active,
    )


def _detect_cpu_percent() -> float | None:
    """Instantaneous CPU utilisation percentage, or ``None``.

    Uses ``psutil`` when present. The pure-Python fallback derives utilisation
    from the 1-minute load average scaled by core count, which is a coarser but
    still useful signal on POSIX hosts.
    """
    try:
        import psutil

        # interval=None returns the value since the previous call, which is what
        # a polling caller wants (and never blocks).
        return float(psutil.cpu_percent(interval=None))
    except ImportError:
        pass
    except Exception:
        return None

    getloadavg = getattr(os, "getloadavg", None)
    cpu_count = os.cpu_count() or 1
    if callable(getloadavg):
        try:
            load = getloadavg()[0]
        except OSError:
            return None
        return max(0.0, min(100.0, (float(load) / cpu_count) * 100.0))
    return None


def _detect_used_memory_gb() -> float | None:
    """Used physical memory in GB, or ``None`` when undetectable."""
    try:
        import psutil

        memory = psutil.virtual_memory()
        return _bytes_to_gb(int(memory.total - memory.available))
    except ImportError:
        pass
    except Exception:
        return None

    # Linux fallback: MemTotal - MemAvailable from /proc/meminfo.
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            fields: dict[str, int] = {}
            for line in handle:
                key, _, rest = line.partition(":")
                value = rest.strip().split(" ")[0]
                if value.isdigit():
                    fields[key] = int(value) * 1024
        total = fields.get("MemTotal")
        available = fields.get("MemAvailable")
        if total and available is not None:
            return _bytes_to_gb(total - available)
    except OSError:
        return None
    return None


def _detect_vram_mb() -> tuple[int | None, int | None]:
    """``(total_mb, used_mb)`` VRAM, either element ``None`` when unreadable.

    Prefers ``nvidia-smi`` (which reports *used* VRAM, the number the monitor
    actually wants) and falls back to the DRM sysfs totals used by
    :func:`_gpu_memory_gb_from_drm_sysfs`.
    """
    smi = _vram_from_nvidia_smi()
    if smi is not None:
        return smi

    total_gb = _gpu_memory_gb_from_drm_sysfs()
    if total_gb is None:
        return (None, None)
    return (int(total_gb * 1024), _drm_vram_used_mb())


def _vram_from_nvidia_smi() -> tuple[int, int] | None:
    """Query ``nvidia-smi`` for ``(total_mb, used_mb)`` of the first GPU."""
    import shutil
    import subprocess

    binary = shutil.which("nvidia-smi")
    if binary is None:
        return None
    try:
        completed = subprocess.run(
            [
                binary,
                "--query-gpu=memory.total,memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    first = completed.stdout.strip().splitlines()[:1]
    if not first:
        return None
    parts = [piece.strip() for piece in first[0].split(",")]
    if len(parts) < 2:
        return None
    try:
        return (int(float(parts[0])), int(float(parts[1])))
    except ValueError:
        return None


def _drm_vram_used_mb() -> int | None:
    """Read used VRAM from DRM sysfs (amdgpu exposes this), or ``None``."""
    drm_root = "/sys/class/drm"
    try:
        entries = os.listdir(drm_root)
    except OSError:
        return None
    for name in entries:
        if not name.startswith("card") or "-" in name:
            continue
        path = os.path.join(drm_root, name, "device", "mem_info_vram_used")
        try:
            with open(path, encoding="utf-8") as handle:
                return int(handle.read().strip()) // (1024 * 1024)
        except (OSError, ValueError):
            continue
    return None


# ── Model recommendation for onboarding (§13.1) ──────────────────────────────


@dataclass(slots=True, frozen=True)
class ModelRecommendation:
    """A concrete local-model suggestion for the detected hardware (§13.1)."""

    model: str
    quantization: str
    #: Approximate download size, so the user can judge before committing.
    approx_size_gb: float
    reason: str
    #: Suggested ``n_gpu_layers``; ``0`` means CPU-only.
    gpu_layers: int


#: Recommendation tiers, richest first. Each entry is
#: ``(min_vram_gb, min_ram_gb, model, quant, size_gb, gpu_layers, reason)``.
#: VRAM decides when a GPU is present; otherwise system RAM does, because a
#: CPU-only host must still get a model it can actually load.
PROFILE_TIERS: tuple[tuple[float, float, str, str, float, int, str], ...] = (
    (
        20.0,
        16.0,
        "Qwen2.5-Coder-32B-Instruct",
        "Q4_K_M",
        19.0,
        999,
        "20 GB+ of VRAM fits a 32B coder model fully on the GPU.",
    ),
    (
        10.0,
        16.0,
        "Qwen2.5-Coder-14B-Instruct",
        "Q4_K_M",
        9.0,
        999,
        "10 GB+ of VRAM fits a 14B coder model fully on the GPU.",
    ),
    (
        6.0,
        8.0,
        "Qwen2.5-Coder-7B-Instruct",
        "Q4_K_M",
        4.7,
        999,
        "6 GB+ of VRAM fits a 7B coder model fully on the GPU.",
    ),
    (
        4.0,
        8.0,
        "Qwen2.5-Coder-7B-Instruct",
        "Q4_K_S",
        4.1,
        24,
        "4 GB of VRAM fits most of a 7B model; the rest runs on the CPU.",
    ),
    (
        0.0,
        16.0,
        "Qwen2.5-Coder-7B-Instruct",
        "Q4_K_M",
        4.7,
        0,
        "No GPU detected, but 16 GB+ of RAM runs a 7B model on the CPU.",
    ),
    (
        0.0,
        8.0,
        "Llama-3.1-8B-Instruct",
        "Q4_K_M",
        4.9,
        0,
        "8 GB of RAM runs an 8B model on the CPU — slower, but it fits.",
    ),
)

#: Fallback for a machine below every tier (or one we could not measure).
_SMALLEST_MODEL = ModelRecommendation(
    model="Qwen2.5-Coder-1.5B-Instruct",
    quantization="Q4_K_M",
    approx_size_gb=1.1,
    gpu_layers=0,
    reason=(
        "Limited or undetectable memory, so this starts with the smallest "
        "coder model. A cloud model will feel much faster here."
    ),
)


def recommend_model(profile: HardwareProfile | None) -> ModelRecommendation:
    """Pick a local model for ``profile`` (§13.1).

    Returns the smallest model when ``profile`` is ``None`` — an unmeasurable
    machine gets a conservative suggestion rather than an optimistic one that
    would fail to load.
    """
    if profile is None:
        return _SMALLEST_MODEL
    vram = profile.gpu_memory_gb or 0.0
    ram = profile.system_memory_gb or 0.0

    for min_vram, min_ram, model, quant, size, layers, reason in PROFILE_TIERS:
        if vram >= min_vram and ram >= min_ram and (min_vram == 0.0 or vram > 0.0):
            return ModelRecommendation(
                model=model,
                quantization=quant,
                approx_size_gb=size,
                gpu_layers=layers,
                reason=reason,
            )
    return _SMALLEST_MODEL
