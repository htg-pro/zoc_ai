"""Property test for memory matrix init creating all missing stores (task 9.6).

Feature: zocai-ecosystem-rebuild, Property 38: Memory matrix initialization
creates all missing stores.

**Validates: Requirements 9.2**

Design Property 38 (verbatim intent): *For any* subset of absent ``.zocai/``
directories or tier sub-stores, initialization creates every missing directory
and sub-store.

Strategy
--------
We drive the real seam this property owns — :meth:`MemoryMatrix.initialize`
against a fresh ``tmp_path`` workspace — across arbitrary *pre-existing* subsets
of the stores the matrix owns:

* the four owned directories (``.zocai/`` and its tier sub-dirs), and
* the four owned tier sub-store files (session diary, state wrapper, SKILL,
  GEPA state).

For each drawn subset we materialize exactly those stores *before* calling
``initialize()`` — seeding any pre-existing file with a unique sentinel so we
can later prove it was left intact. After initialization we assert:

* **R9.2 create-on-init.** Every owned directory and sub-store now exists,
  regardless of which subset was absent beforehand.
* **Idempotence / no truncation.** Every store that pre-existed keeps its exact
  sentinel content (initialization only creates what is missing).
* **R9.1 confinement.** The only entry created directly under the workspace
  root is ``.zocai/``, and every owned path stays under that subtree.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.memory import MemoryMatrix

# The stable names the matrix uses to expose its owned stores. Splitting them
# lets the strategy pick an arbitrary present/absent subset over the full set
# of directories and tier sub-store files independently.
_DIR_ATTRS = (
    "zocai_dir",
    "traces_dir",
    "cross_model_bus_dir",
    "hermes_evolution_dir",
)
_FILE_ATTRS = (
    "session_diary_path",
    "state_wrapper_path",
    "skill_path",
    "gepa_state_path",
)
_ALL_ATTRS = _DIR_ATTRS + _FILE_ATTRS


def _sentinel_for(attr: str) -> str:
    """A unique, recognizable pre-seed payload for a pre-existing file store."""
    return f"PRESEEDED::{attr}::do-not-truncate\n"


# Any subset (including empty and full) of the matrix's owned stores may already
# exist before init. ``unique`` keeps each store at most once in the draw.
_present_subsets = st.lists(st.sampled_from(_ALL_ATTRS), unique=True)


@settings(max_examples=200)
@given(present=_present_subsets)
def test_initialize_creates_every_missing_store(present: list[str]) -> None:
    # A fresh, isolated workspace per example. Hypothesis reuses a single
    # function-scoped ``tmp_path`` across all examples, so we mint our own temp
    # root each run to guarantee every example starts from a clean slate.
    root = Path(tempfile.mkdtemp(prefix="zocai_matrix_prop_"))
    try:
        workspace = root / "workspace"
        workspace.mkdir()
        matrix = MemoryMatrix(workspace)

        present_set = set(present)

        # Materialize exactly the chosen pre-existing subset. Creating a file
        # store requires its parent directory, so we make parents on demand
        # (this never creates a store outside the owned set, and ``initialize``
        # must still treat any not-explicitly-present store as missing).
        preseeded: dict[str, str] = {}
        for attr in _DIR_ATTRS:
            if attr in present_set:
                getattr(matrix, attr).mkdir(parents=True, exist_ok=True)
        for attr in _FILE_ATTRS:
            if attr in present_set:
                path: Path = getattr(matrix, attr)
                path.parent.mkdir(parents=True, exist_ok=True)
                content = _sentinel_for(attr)
                path.write_text(content, encoding="utf-8")
                preseeded[attr] = content

        matrix.initialize()

        # R9.2: every owned directory and sub-store now exists, regardless of
        # which subset was absent beforehand.
        for attr in _DIR_ATTRS:
            assert getattr(matrix, attr).is_dir(), f"missing directory store: {attr}"
        for attr in _FILE_ATTRS:
            assert getattr(matrix, attr).is_file(), f"missing file store: {attr}"
        assert matrix.is_initialized() is True

        # Idempotence: any store that pre-existed is left exactly as found.
        for attr, content in preseeded.items():
            path = getattr(matrix, attr)
            assert path.read_text(encoding="utf-8") == content, (
                f"pre-existing store was truncated/overwritten: {attr}"
            )

        # R9.1 confinement: only ``.zocai/`` is created under the workspace
        # root, and every owned path lives under that subtree.
        assert [p.name for p in workspace.iterdir()] == [".zocai"]
        for attr in _ALL_ATTRS:
            path = getattr(matrix, attr)
            assert path == matrix.zocai_dir or matrix.zocai_dir in path.parents
    finally:
        shutil.rmtree(root, ignore_errors=True)
