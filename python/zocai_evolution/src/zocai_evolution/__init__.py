"""Zoc AI parametric evolution engine (Layer 5, Requirement 12).

Phase 1: trajectory capture on verified runs (R12.1), publication to the
shared-memory weight bus (R12.2), a distillation gate requiring both ≥ 50
collected trajectories and operational recording (R12.3, R12.5), isolated
recording-failure handling that keeps the runtime operational (R12.4, R12.6),
and a feature-flagged distillation stub (NeMo backend and weight feedback
deferred to Phases 2 and 3). Replaces the legacy ``python/llama_studio_neural``
package.
"""

from __future__ import annotations

from .capture import (
    TrajectoryCapture,
    TrajectoryRecordingError,
    WeightBusTrajectoryCapture,
)
from .distillation import (
    TRAJECTORY_THRESHOLD,
    Distiller,
    DistillResult,
    StubDistiller,
    gate_open,
)
from .engine import ErrorEmitter, EvolutionEngine
from .models import CheckOutcome, CompletedRun, Diff, Stage, Trajectory
from .weight_bus import InMemoryWeightBus, WeightBus

__version__ = "0.1.0"

__all__ = [
    "TRAJECTORY_THRESHOLD",
    "CheckOutcome",
    "CompletedRun",
    "Diff",
    "DistillResult",
    "Distiller",
    "ErrorEmitter",
    "EvolutionEngine",
    "InMemoryWeightBus",
    "Stage",
    "StubDistiller",
    "Trajectory",
    "TrajectoryCapture",
    "TrajectoryRecordingError",
    "WeightBus",
    "WeightBusTrajectoryCapture",
    "__version__",
    "gate_open",
]
