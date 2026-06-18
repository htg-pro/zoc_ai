"""Property test for APPLY_EDITS apply-failure retention (task 5.11).

Feature: zocai-ecosystem-rebuild, Property 17: Apply failure retains prior
changes and reports the failed change.

**Validates: Requirements 3.9**

Design Property 17 (verbatim intent): *For any* edit plan in which applying one
change fails, APPLY_EDITS halts on that change — the changes already applied are
retained (both in the :class:`ApplyOutcome` and on disk), an error event naming
the failed change is emitted over the bus, and no later change is attempted.

Strategy
--------
The property is exercised against the real :class:`EditCoordinator` and a real
:class:`FullToolset` confined to a fresh temporary workspace per example (no
mocks). For each example we:

* draw a list of otherwise-valid changes, each writing distinct in-workspace
  files with arbitrary text content;
* construct one *failing* change whose path escapes the workspace
  (``../<name>``), which the toolset rejects with a :class:`ReadOnlyViolation`;
* insert that failing change at a **random index** in the otherwise-valid list.

We then assert the apply-failure contract holds regardless of where the failure
falls:

* the outcome is not ok and ``failed`` is exactly the inserted failing change;
* ``applied`` is exactly the prefix of valid changes preceding the failure, and
  each is present on disk with its planned content (retention, R3.9);
* every change after the failure is *not* attempted — its file does not exist
  and no ``edit-file`` event was emitted for it;
* exactly one error :class:`CommandEvent` is emitted, naming the failed change,
  and it conforms to the Event_Contract.
"""

from __future__ import annotations

import itertools
import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import (
    AgentEvent as AgentEventUnion,
)
from shared_schema.agent_events import (
    AgentEventModel,
    CommandEvent,
    EditFileEvent,
)

from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.toolsets import FullToolset

# Text that round-trips faithfully through utf-8 text-mode file writes. Control
# characters are excluded ("Cc") because CR/LF undergo newline translation on
# read — a newline-fidelity concern orthogonal to the retention property under
# test — and surrogates ("Cs") are not encodable as utf-8.
_SAFE_TEXT = st.text(
    alphabet=st.characters(blacklist_categories=("Cs", "Cc")),
    max_size=40,
)
# A simple basename used for the out-of-workspace failing change.
_SAFE_NAME = st.text(
    alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd")),
    min_size=1,
    max_size=8,
)


@settings(max_examples=150)
@given(
    contents=st.lists(_SAFE_TEXT, min_size=0, max_size=6),
    fail_offset=st.integers(min_value=0, max_value=6),
    escape_name=_SAFE_NAME,
    data=st.data(),
)
def test_apply_failure_retains_prior_changes_and_reports_failed(
    contents: list[str],
    fail_offset: int,
    escape_name: str,
    data: st.DataObject,
) -> None:
    """Property 17: a failed change halts apply, retaining the prior changes.

    Feature: zocai-ecosystem-rebuild, Property 17

    **Validates: Requirements 3.9**
    """
    n = len(contents)
    # Otherwise-valid changes write distinct in-workspace files.
    valid_changes = [
        PlannedChange(path=f"valid_{i}.txt", content=contents[i], diff=f"+{i}")
        for i in range(n)
    ]
    # The failing change escapes the workspace -> ReadOnlyViolation on write.
    escape_path = f"../{escape_name}.txt"
    failing = PlannedChange(path=escape_path, content="boom")

    # Place the failing change at a random index within the valid list.
    fail_index = fail_offset % (n + 1)
    changes = (*valid_changes[:fail_index], failing, *valid_changes[fail_index:])
    prior = valid_changes[:fail_index]
    later = valid_changes[fail_index:]

    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp)
        recorded: list[AgentEventUnion] = []
        coord = EditCoordinator(
            toolset=FullToolset(workspace_root=workspace),
            run_id="r1",
            emit=recorded.append,
            next_seq=itertools.count().__next__,
        )

        outcome = coord.apply_edits(EditPlan(reasoning="r", changes=changes))

        # Halted on the failing change; it is reported as the failure (R3.9).
        assert outcome.ok is False
        assert outcome.failed == failing
        assert outcome.error is not None and escape_name in outcome.error

        # The changes already applied are retained, in order, in the outcome.
        assert outcome.applied == tuple(prior)

        # ...and on disk: each prior change's file holds its planned content.
        for change in prior:
            assert (workspace / change.path).read_text(encoding="utf-8") == change.content

        # No later change was attempted: no file written for any of them.
        for change in later:
            assert not (workspace / change.path).exists()
        # The out-of-workspace failing change never landed in the workspace.
        assert not (workspace / f"{escape_name}.txt").exists()

        # One edit-file event per retained change, in order; none for later ones.
        edit_events = [e for e in recorded if isinstance(e, EditFileEvent)]
        assert [e.path for e in edit_events] == [c.path for c in prior]

        # Exactly one error event was emitted, naming the failed change (R3.9).
        error_events = [e for e in recorded if isinstance(e, CommandEvent)]
        assert len(error_events) == 1
        err = error_events[0]
        assert err.command == f"apply-edit:{escape_path}"
        assert err.exit_code != 0
        assert err.error_tag is not None and escape_name in err.error_tag
        # The error event conforms to the Event_Contract (R6.2).
        AgentEventModel.model_validate(err.model_dump(by_alias=True))

        # The error event is the last event on the stream — nothing emitted after
        # the halt — confirming no later change was attempted.
        assert isinstance(recorded[-1], CommandEvent)
