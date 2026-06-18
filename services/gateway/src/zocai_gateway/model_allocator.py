"""The ``Model_Allocator`` — tier selection, window sizing, and fallback (R1).

The allocator turns three run-time signals into a single, ready-to-use
:class:`Allocation`:

* a **task complexity** score normalized to ``[0.0, 1.0]`` (R1.2),
* a **network latency** in milliseconds, ``None`` when it could not be
  measured (R1.2, R1.6), and
* a **hardware profile** (:class:`~zocai_gateway.hardware_probe.HardwareProfile`)
  of available GPU/system memory, ``None`` when probing failed (R1.2, R1.6).

From those it selects **exactly one** :class:`~zocai_gateway.model_interface.ModelTier`
(R1.2) and sizes the context window to that tier's bounds (R1.3–R1.5).

Two fallbacks protect the run:

* **R1.6** — if hardware *or* latency is unavailable, the allocator selects the
  Local SLM tier and records a structured ``fallback_reason`` so the first
  emitted event can carry it, keeping the run operational.
* **R1.10** — falling back to Local SLM is only safe if that tier can actually
  be brought up. The fallback initializes the tier and allocates its context
  window inside a guard. If initialization fails or context allocation fails,
  the allocator emits an error indication that *identifies which* failure
  occurred (initialization vs. allocation) and raises
  :class:`AllocationAborted` instead of returning an invalid (unallocated or
  out-of-bounds) window — the run does not proceed.

Tier selection, window sizing, and fallback all live here; the uniform
per-tier contract lives in :mod:`zocai_gateway.model_interface`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum

from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.model_interface import (
    Cloud,
    Edge,
    LocalSLM,
    ModelInterface,
    ModelTier,
)

__all__ = [
    "Allocation",
    "AllocationError",
    "AllocationErrorKind",
    "AllocationAborted",
    "TierInitError",
    "ContextAllocationError",
    "ModelAllocator",
    "FALLBACK_REASON_UNAVAILABLE",
]

# The single structured reason recorded when the R1.6 fallback fires because
# hardware or latency could not be obtained. Carried onto the run's first
# emitted event (R1.6, R1.9).
FALLBACK_REASON_UNAVAILABLE = "hardware_or_latency_unavailable"

# Context-window size allocated per tier, in tokens. Each value sits inside the
# tier's required bounds: Local SLM in [2_000, 4_000] (R1.3), Edge in
# [8_000, 128_000] (R1.4), Cloud at >= 1_000_000 (R1.5).
_TIER_WINDOW: dict[ModelTier, int] = {
    ModelTier.LOCAL_SLM: 4_000,
    ModelTier.EDGE: 128_000,
    ModelTier.CLOUD: 1_000_000,
}

# Scoring thresholds combining the three selection signals. These are the
# allocator's policy knobs: higher complexity demands more scale, while high
# latency or thin local memory pulls the choice back down toward Local SLM.
#
# * Complexity at or above the cloud threshold, with reachable network, earns
#   the Cloud tier.
# * Complexity at or above the edge threshold, with enough local memory and a
#   reachable network, earns the Edge tier.
# * Everything else stays on the always-available Local SLM tier.
_COMPLEXITY_EDGE_THRESHOLD = 0.34
_COMPLEXITY_CLOUD_THRESHOLD = 0.67
# Above this round-trip latency the network-dependent tiers are treated as
# unreliable and the selection is pulled down to Local SLM.
_LATENCY_ACCEPTABLE_MS = 1_000.0
# Minimum detected memory (max of GPU / system, in GB) needed to justify the
# Edge tier; below this the run stays on Local SLM.
_EDGE_MIN_MEMORY_GB = 8.0


class AllocationErrorKind(str, Enum):
    """Which part of bringing up the fallback tier failed (R1.10).

    The allocator must *identify* whether a fallback failure was an
    initialization failure or a context-allocation failure, so the emitted
    error indication carries this discriminator.
    """

    INITIALIZATION = "initialization"
    ALLOCATION = "allocation"


@dataclass(slots=True, frozen=True)
class Allocation:
    """The result of a successful allocation.

    ``fallback_reason`` is ``None`` for a normally scored selection and is set
    to a structured string when the R1.6 Local SLM fallback fired, so the
    run's first emitted event can record it (R1.6, R1.9).
    """

    tier: ModelTier
    context_window: int
    fallback_reason: str | None = None


@dataclass(slots=True, frozen=True)
class AllocationError:
    """A structured error indication emitted when the fallback cannot stand up.

    Identifies the failing tier and whether the failure was an initialization
    or a context-allocation failure (R1.10).
    """

    tier: ModelTier
    kind: AllocationErrorKind
    message: str


class TierInitError(Exception):
    """Raised internally when a tier cannot be initialized (R1.10).

    Carries :attr:`kind` = :attr:`AllocationErrorKind.INITIALIZATION` so the
    guard can report the failure category without inspecting the type.
    """

    kind = AllocationErrorKind.INITIALIZATION

    def __init__(self, tier: ModelTier, message: str = "") -> None:
        self.tier = tier
        super().__init__(message or f"failed to initialize tier {tier.value}")


class ContextAllocationError(Exception):
    """Raised internally when a tier's context window cannot be allocated (R1.10).

    Carries :attr:`kind` = :attr:`AllocationErrorKind.ALLOCATION`.
    """

    kind = AllocationErrorKind.ALLOCATION

    def __init__(self, tier: ModelTier, message: str = "") -> None:
        self.tier = tier
        super().__init__(message or f"failed to allocate context for tier {tier.value}")


class AllocationAborted(Exception):
    """Raised to stop the run when the guarded fallback cannot proceed (R1.10).

    Prevents the run from continuing with an invalid context window. Carries
    the failure :attr:`kind` and the affected :attr:`tier`.
    """

    def __init__(self, kind: AllocationErrorKind, tier: ModelTier = ModelTier.LOCAL_SLM) -> None:
        self.kind = kind
        self.tier = tier
        super().__init__(f"allocation aborted: {kind.value} failure on tier {tier.value}")


# A tier bring-up step: given a tier, initialize it and allocate its context
# window, returning the live model. It may raise ``TierInitError`` (init
# failed) or ``ContextAllocationError`` (window allocation failed). The default
# genuinely constructs the concrete tier stub.
TierBringUp = Callable[[ModelTier], ModelInterface]

# A sink for emitted allocation error indications (R1.10).
ErrorSink = Callable[[AllocationError], None]

_TIER_STUBS: dict[ModelTier, Callable[[], ModelInterface]] = {
    ModelTier.LOCAL_SLM: LocalSLM,
    ModelTier.EDGE: Edge,
    ModelTier.CLOUD: Cloud,
}


def _default_bring_up(tier: ModelTier) -> ModelInterface:
    """Default tier bring-up: construct the concrete tier stub.

    This is a genuine initialization (it instantiates the tier's
    :class:`~zocai_gateway.model_interface.ModelInterface` implementation) and
    does not fail under normal conditions. Degraded environments inject a
    bring-up that raises :class:`TierInitError` / :class:`ContextAllocationError`
    to exercise the R1.10 guard.
    """
    return _TIER_STUBS[tier]()


class ModelAllocator:
    """Selects exactly one tier and sizes its context window (R1.2–R1.6, R1.10).

    The bring-up step and the error sink are injectable so the R1.10 fallback
    guard can be driven without touching real model runtimes: a caller can
    supply a bring-up that fails on initialization or on context allocation,
    and collect the emitted :class:`AllocationError` indications.
    """

    def __init__(
        self,
        *,
        bring_up: TierBringUp | None = None,
        error_sink: ErrorSink | None = None,
    ) -> None:
        self._bring_up: TierBringUp = bring_up if bring_up is not None else _default_bring_up
        self._error_sink: ErrorSink | None = error_sink
        # Every error indication emitted during this allocator's lifetime, in
        # emission order, so callers without a custom sink can still observe
        # what was reported (R1.10).
        self.allocation_errors: list[AllocationError] = []

    def select(
        self,
        complexity: float,
        latency_ms: float | None,
        hw: HardwareProfile | None,
    ) -> Allocation:
        """Select one tier and allocate its window for the given signals.

        Returns a fully sized :class:`Allocation`. When hardware or latency is
        unavailable it takes the **guarded** Local SLM fallback (R1.6 + R1.10);
        if that fallback cannot be brought up it raises
        :class:`AllocationAborted` rather than returning an invalid window.
        """
        # R1.6: missing hardware or latency -> guarded Local SLM fallback.
        if hw is None or latency_ms is None:
            return self.fallback_to_local_slm()

        tier = self._score_tier(complexity, latency_ms, hw)
        return Allocation(
            tier=tier,
            context_window=self._window(tier),
            fallback_reason=None,
        )

    def fallback_to_local_slm(self) -> Allocation:
        """Take the R1.6 Local SLM fallback, guarded per R1.10.

        Falling back is only safe if the Local SLM tier can actually come up:
        the tier is initialized and its context window allocated inside a
        guard. If either step fails, an error indication identifying the
        failure category is emitted and the run is aborted — the allocator does
        not return an invalid allocation.
        """
        try:
            self._init_tier(ModelTier.LOCAL_SLM)
            window = self._window(ModelTier.LOCAL_SLM)
        except (TierInitError, ContextAllocationError) as exc:
            # R1.10: emit an error indication identifying init vs allocation,
            # then stop the run rather than proceed with an invalid window.
            self._emit_allocation_error(kind=exc.kind, tier=ModelTier.LOCAL_SLM, message=str(exc))
            raise AllocationAborted(exc.kind, ModelTier.LOCAL_SLM) from exc
        return Allocation(
            tier=ModelTier.LOCAL_SLM,
            context_window=window,
            fallback_reason=FALLBACK_REASON_UNAVAILABLE,
        )

    def _score_tier(self, complexity: float, latency_ms: float, hw: HardwareProfile) -> ModelTier:
        """Map the three signals to exactly one tier (R1.2).

        High complexity with a reachable network earns Cloud; mid complexity
        with enough local memory and a reachable network earns Edge; otherwise
        the always-available Local SLM tier is chosen. Latency is clamped at
        zero so a spurious negative reading cannot widen eligibility.
        """
        reachable = max(latency_ms, 0.0) <= _LATENCY_ACCEPTABLE_MS
        gpu = hw.gpu_memory_gb or 0.0
        system = hw.system_memory_gb or 0.0
        memory_gb = max(gpu, system)

        if reachable and complexity >= _COMPLEXITY_CLOUD_THRESHOLD:
            return ModelTier.CLOUD
        if reachable and complexity >= _COMPLEXITY_EDGE_THRESHOLD and memory_gb >= _EDGE_MIN_MEMORY_GB:
            return ModelTier.EDGE
        return ModelTier.LOCAL_SLM

    def window_for(self, tier: ModelTier) -> int:
        """Public context-window size (tokens) the allocator assigns ``tier``.

        Exposes the per-tier window sizing (R1.3–R1.5) so the model hot-swap
        can rebuild a replacement tier's prompt window to exactly the size the
        allocator would assign it (R11.3) without re-running tier selection.
        """
        return self._window(tier)

    def _window(self, tier: ModelTier) -> int:
        """Context window size (tokens) for ``tier``, within its bounds (R1.3–R1.5)."""
        return _TIER_WINDOW[tier]

    def _init_tier(self, tier: ModelTier) -> ModelInterface:
        """Bring up ``tier`` via the injected bring-up step (R1.10).

        Propagates :class:`TierInitError` / :class:`ContextAllocationError` so
        the fallback guard can categorize and report the failure.
        """
        return self._bring_up(tier)

    def _emit_allocation_error(
        self, *, kind: AllocationErrorKind, tier: ModelTier, message: str
    ) -> None:
        """Record and dispatch a structured allocation error indication (R1.10)."""
        error = AllocationError(tier=tier, kind=kind, message=message)
        self.allocation_errors.append(error)
        if self._error_sink is not None:
            self._error_sink(error)
