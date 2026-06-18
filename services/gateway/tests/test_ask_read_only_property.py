"""Property test for Ask Mode read-only enforcement (task 4.4).

Feature: zocai-ecosystem-rebuild, Property 9: Ask Mode is read-only.

**Validates: Requirements 2.3, 2.4**

Design Property 9 (verbatim intent): *For any* attempted file write, shell
execution, or directory modification while Ask Mode is active, the operation is
blocked, the workspace files and directories are unchanged, and an error
indication names the rejected operation type.

Strategy
--------
The read-only guarantee has two enforcement layers, and this module exercises
both across the input space:

1. **Capability gate (the structural guarantee).** The Ask path is constructed
   with a :class:`ReadOnlyToolset` that *physically lacks* the mutating
   operations (``write_file`` / ``run_shell`` / ``make_dir``), so a mutating
   call is unconstructable rather than merely rejected. For any mutating
   operation name we assert the read-only toolset exposes no such attribute
   while the full toolset does.

2. **Boundary conversion (R2.3).** When a mutating attempt nonetheless reaches
   the read-only boundary and surfaces as a :class:`ReadOnlyViolation`,
   :meth:`AskPath.execute` converts it into an :class:`AskError` naming the
   rejected operation type, *and the materialized workspace is byte-for-byte
   unchanged*. We drive this over arbitrary operation names and arbitrary
   workspace trees, snapshotting the workspace before and after.

3. **Switch-to-Agent (R2.4).** For any edit/implementation request, execute
   returns a :class:`SwitchToAgentMessage` without invoking the generator and
   without modifying any file, directory, or workspace state, verified against
   the same before/after workspace snapshot.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zocai_gateway.mode_router import (
    AgentRunRequest,
    AskContext,
    AskError,
    AskPath,
    Mode,
    SwitchToAgentMessage,
    is_edit_request,
)
from zocai_gateway.toolsets import FullToolset, ReadOnlyToolset, ReadOnlyViolation

# The mutating operation families a read-only path must never perform (R2.3):
# file write, shell execution, directory modification. The full (Agent) toolset
# exposes exactly these as attributes; the read-only toolset must not.
_MUTATING_OPERATIONS = ("write_file", "run_shell", "make_dir")

# Edit/implementation imperative verbs (R2.4). A leading edit verb makes the
# prompt an edit request per the Mode_Router intent classifier.
_EDIT_VERBS = (
    "implement", "create", "write", "edit", "modify", "change", "add",
    "delete", "remove", "refactor", "rename", "fix", "build", "generate",
)

# Safe relative file names for materializing an arbitrary workspace tree.
_safe_names = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyz0123456789_-", min_size=1, max_size=12
)


@st.composite
def _workspace_files(draw: st.DrawFn) -> dict[str, str]:
    """A small arbitrary set of workspace files (name → text content)."""
    names = draw(st.lists(_safe_names, min_size=0, max_size=5, unique=True))
    return {f"{name}.txt": draw(st.text(max_size=64)) for name in names}


def _materialize(root: Path, files: dict[str, str]) -> None:
    for name, content in files.items():
        (root / name).write_text(content, encoding="utf-8")


def _snapshot(root: Path) -> dict[str, str]:
    """Map every file under ``root`` to its text content (recursive)."""
    return {
        str(path.relative_to(root)): path.read_text(encoding="utf-8")
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _ask(prompt: str) -> AgentRunRequest:
    return AgentRunRequest(prompt=prompt, mode=Mode.ASK)


@given(operation=st.sampled_from(_MUTATING_OPERATIONS))
@settings(max_examples=100)
def test_read_only_toolset_physically_lacks_mutating_operations(
    operation: str,
) -> None:
    """Property 9 (capability gate): mutating ops are unconstructable in Ask.

    Feature: zocai-ecosystem-rebuild, Property 9

    **Validates: Requirements 2.3**

    The read-only toolset exposes no mutating operation, while the full
    (Agent) toolset does — the absence is the read-only guarantee.
    """
    read_only = ReadOnlyToolset()
    full = FullToolset()

    assert not hasattr(read_only, operation)
    # read capability is shared and must remain available in Ask Mode.
    assert hasattr(read_only, "read_file")
    # the Agent toolset is the one that may mutate.
    assert hasattr(full, operation)


@given(
    operation=st.one_of(
        st.sampled_from(_MUTATING_OPERATIONS),
        st.text(min_size=1, max_size=32),
    ),
    files=_workspace_files(),
    prompt=st.text(max_size=80),
)
@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
def test_read_only_violation_becomes_error_and_workspace_untouched(
    operation: str,
    files: dict[str, str],
    prompt: str,
) -> None:
    """Property 9 (R2.3): a violation becomes an error, workspace unchanged.

    Feature: zocai-ecosystem-rebuild, Property 9

    **Validates: Requirements 2.3**

    For any attempted mutating operation surfacing as a ``ReadOnlyViolation``
    while generating an Ask response, ``execute`` returns an ``AskError``
    naming the rejected operation type and leaves every workspace file and
    directory byte-for-byte unchanged.
    """
    # A non-edit prompt so we reach generation rather than the R2.4 branch.
    question = f"what is {prompt}?"

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _materialize(root, files)
        before = _snapshot(root)

        def generate(_prompt: str, _context: AskContext) -> str:
            # A mutating attempt reaching the read-only boundary (R2.3).
            raise ReadOnlyViolation(operation)

        result = AskPath().execute(
            _ask(question), generate=generate, workspace_root=root
        )

        # The violation is converted into an error naming the rejected op.
        assert isinstance(result, AskError)
        # R2.3: the rejected operation type is named exactly on the error ...
        assert result.operation == operation
        # ... and identified in the human-readable message (repr form, so the
        # assertion holds even for operation names containing control chars).
        assert repr(operation) in result.message
        # The workspace is left untouched.
        assert _snapshot(root) == before


@given(
    verb=st.sampled_from(_EDIT_VERBS),
    tail=st.text(max_size=80),
    files=_workspace_files(),
)
@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
def test_edit_request_switches_to_agent_without_mutation(
    verb: str,
    tail: str,
    files: dict[str, str],
) -> None:
    """Property 9 (R2.4): edit requests switch to Agent without mutating.

    Feature: zocai-ecosystem-rebuild, Property 9

    **Validates: Requirements 2.4**

    For any edit/implementation request in Ask Mode, ``execute`` returns a
    ``SwitchToAgentMessage`` without invoking the generator and without
    modifying any file, directory, or workspace state.
    """
    prompt = f"{verb} {tail}".strip()
    # Guard: the constructed prompt is genuinely classified as an edit request.
    assert is_edit_request(prompt)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _materialize(root, files)
        before = _snapshot(root)

        generate_calls: list[str] = []

        def generate(prompt: str, _context: AskContext) -> str:
            generate_calls.append(prompt)
            return "should not be produced for an edit request"

        result = AskPath().execute(
            _ask(prompt), generate=generate, workspace_root=root
        )

        # R2.4: a switch-to-Agent message, no generation, no mutation.
        assert isinstance(result, SwitchToAgentMessage)
        assert generate_calls == []
        assert _snapshot(root) == before
