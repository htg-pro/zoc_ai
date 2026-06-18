"""``.zocai/`` initialization for the three-tier memory matrix (task 9.1).

This module owns the on-disk layout of the per-workspace memory matrix and its
idempotent initialization. Two invariants drive the design:

* **Confinement (R9.1).** Every store the matrix touches lives *under* the
  workspace ``.zocai/`` directory. Initialization never creates a file or
  directory outside that subtree.
* **Create-on-init (R9.2).** When the matrix is initialized and the ``.zocai/``
  directory or any of its tier sub-stores is absent, the missing directory and
  sub-stores are created. Initialization is idempotent: existing stores are
  left exactly as they are (no truncation, no overwrite).

The on-disk layout mirrors the design's "Three-Tier Local Memory Matrix
(Layer 4, ``.zocai/``)" section::

    project-root/
    └── .zocai/
        ├── session_diary.jsonl              # Tier 1 — append-only event log
        ├── traces/                          # execution step histories
        ├── cross_model_bus/
        │   └── state_wrapper.json           # Tier 2 — model-agnostic state
        └── hermes-evolution/
            ├── SKILL.md                     # Tier 3 — evolved prompt scripts
            └── gepa_state.json              # GEPA population / Pareto front

The workspace root is injectable so tests (and embedding callers) can point the
matrix at a temporary directory. The Diary_Worker (Tier 1), State_Wrapper store
(Tier 2), and Hermes_Evolution loop (Tier 3) build on this layout in later
tasks; this module only guarantees the stores exist.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "MemoryMatrix",
    "ZOCAI_DIR",
    "SESSION_DIARY_FILE",
    "TRACES_DIR",
    "CROSS_MODEL_BUS_DIR",
    "STATE_WRAPPER_FILE",
    "HERMES_EVOLUTION_DIR",
    "SKILL_FILE",
    "GEPA_STATE_FILE",
]

# Root of the matrix, relative to the workspace root (R9.1).
ZOCAI_DIR = ".zocai"

# Tier 1 — append-only session diary (R9.3, R9.4).
SESSION_DIARY_FILE = "session_diary.jsonl"
# Execution step histories consumed by Hermes_Evolution (Tier 3).
TRACES_DIR = "traces"

# Tier 2 — cross-model bus / model-agnostic state wrapper (R9.5, R9.6).
CROSS_MODEL_BUS_DIR = "cross_model_bus"
STATE_WRAPPER_FILE = "state_wrapper.json"

# Tier 3 — Hermes-Evolution / GEPA prompt self-evolution (R9.7).
HERMES_EVOLUTION_DIR = "hermes-evolution"
SKILL_FILE = "SKILL.md"
GEPA_STATE_FILE = "gepa_state.json"

# Initial content for freshly created sub-stores. Append-only / markdown stores
# start empty; JSON stores start as a valid empty document so downstream readers
# never have to special-case a zero-byte file.
_EMPTY_JSON_OBJECT = "{}\n"


@dataclass(frozen=True, slots=True)
class MemoryMatrix:
    """The per-workspace three-tier memory matrix rooted at ``.zocai/``.

    The matrix is constructed against an injectable ``workspace_root`` so the
    whole tree can be redirected at a temporary directory in tests. All paths
    the matrix exposes resolve under :attr:`zocai_dir`, enforcing the R9.1
    confinement invariant.
    """

    workspace_root: Path

    def __init__(self, workspace_root: Path | str) -> None:
        # Normalize to an absolute Path so every derived store path is stable
        # and confinement can be reasoned about without surprises from a
        # relative cwd. ``object.__setattr__`` is required because the
        # dataclass is frozen.
        object.__setattr__(self, "workspace_root", Path(workspace_root).resolve())

    # -- Derived store paths (all confined under ``.zocai/``, R9.1) ---------

    @property
    def zocai_dir(self) -> Path:
        """The matrix root, ``<workspace_root>/.zocai`` (R9.1)."""
        return self.workspace_root / ZOCAI_DIR

    @property
    def session_diary_path(self) -> Path:
        """Tier 1 append-only event log."""
        return self.zocai_dir / SESSION_DIARY_FILE

    @property
    def traces_dir(self) -> Path:
        """Execution step histories directory."""
        return self.zocai_dir / TRACES_DIR

    @property
    def cross_model_bus_dir(self) -> Path:
        """Tier 2 cross-model bus directory."""
        return self.zocai_dir / CROSS_MODEL_BUS_DIR

    @property
    def state_wrapper_path(self) -> Path:
        """Tier 2 model-agnostic state wrapper."""
        return self.cross_model_bus_dir / STATE_WRAPPER_FILE

    @property
    def hermes_evolution_dir(self) -> Path:
        """Tier 3 Hermes-Evolution directory."""
        return self.zocai_dir / HERMES_EVOLUTION_DIR

    @property
    def skill_path(self) -> Path:
        """Tier 3 evolved prompt scripts."""
        return self.hermes_evolution_dir / SKILL_FILE

    @property
    def gepa_state_path(self) -> Path:
        """Tier 3 GEPA population / Pareto front state."""
        return self.hermes_evolution_dir / GEPA_STATE_FILE

    def directories(self) -> tuple[Path, ...]:
        """Every directory the matrix owns, parents before children."""
        return (
            self.zocai_dir,
            self.traces_dir,
            self.cross_model_bus_dir,
            self.hermes_evolution_dir,
        )

    def files(self) -> tuple[Path, ...]:
        """Every tier sub-store file the matrix owns."""
        return (
            self.session_diary_path,
            self.state_wrapper_path,
            self.skill_path,
            self.gepa_state_path,
        )

    # -- Initialization (R9.2) ---------------------------------------------

    def initialize(self) -> None:
        """Create any missing ``.zocai/`` directory or tier sub-store (R9.2).

        Idempotent: directories are created with ``exist_ok=True`` and files
        are only written when absent, so an already-initialized matrix is left
        untouched (existing diary/state content is never truncated). All writes
        stay confined under :attr:`zocai_dir` (R9.1).
        """
        for directory in self.directories():
            directory.mkdir(parents=True, exist_ok=True)

        # Seed each missing sub-store with its initial content. JSON stores get
        # a valid empty document; append-only and markdown stores start empty.
        self._create_if_missing(self.session_diary_path, "")
        self._create_if_missing(self.state_wrapper_path, _EMPTY_JSON_OBJECT)
        self._create_if_missing(self.skill_path, "")
        self._create_if_missing(self.gepa_state_path, _EMPTY_JSON_OBJECT)

    def is_initialized(self) -> bool:
        """Return whether every owned directory and sub-store already exists."""
        return all(d.is_dir() for d in self.directories()) and all(
            f.is_file() for f in self.files()
        )

    @staticmethod
    def _create_if_missing(path: Path, content: str) -> None:
        """Write ``content`` to ``path`` only when ``path`` does not yet exist.

        Uses exclusive creation (``"x"``) so an existing store is preserved even
        under a race, satisfying the "create the missing sub-store" wording of
        R9.2 without clobbering retained history.
        """
        if path.exists():
            return
        try:
            with path.open("x", encoding="utf-8") as handle:
                handle.write(content)
        except FileExistsError:
            # Created concurrently between the check and the open; the store
            # exists, which is all R9.2 requires.
            return
