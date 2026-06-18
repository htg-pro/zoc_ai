"""Property test for mode routing (task 4.3).

Feature: zocai-ecosystem-rebuild, Property 8: Mode routing maps mode to the
correct path and initial conditions.

**Validates: Requirements 2.1, 3.1**

Design Property 8 (verbatim intent): *For any* request, mode "ask" routes to
the Ask path with ``skip_planner`` true, and mode "agent" routes to the Agent
path with the FSM initialized at INTAKE.

Strategy
--------
We drive the real :class:`ModeRouter.route` across the full mode domain
(:class:`Mode.ASK` / :class:`Mode.AGENT`) paired with arbitrary prompt text,
so routing is verified independent of prompt content. For every drawn request
we assert the exhaustive routing contract:

* ``mode = "ask"`` → an :class:`AskPath` that is read-only, skips the planner,
  and carries a :class:`ReadOnlyToolset` (R2.1);
* ``mode = "agent"`` → an :class:`AgentPath` that is not read-only, runs the
  planner, carries a :class:`FullToolset`, and has its FSM initialized at
  :attr:`Stage.INTAKE` (R3.1).
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import (
    AgentPath,
    AgentRunRequest,
    AskPath,
    Mode,
    ModeRouter,
)
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset, ReadOnlyToolset

# Arbitrary prompt text: routing must not depend on prompt content.
_prompts = st.text(max_size=200)


@settings(max_examples=200)
@given(mode=st.sampled_from(Mode), prompt=_prompts)
def test_mode_routing_maps_mode_to_path_and_initial_conditions(
    mode: Mode,
    prompt: str,
) -> None:
    """Property 8: routing maps each mode to its path and initial conditions.

    Feature: zocai-ecosystem-rebuild, Property 8

    **Validates: Requirements 2.1, 3.1**
    """
    path = ModeRouter().route(AgentRunRequest(prompt=prompt, mode=mode))

    if mode is Mode.ASK:
        # R2.1: Ask path, read-only, planner skipped, read-only toolset.
        assert isinstance(path, AskPath)
        assert path.mode is Mode.ASK
        assert path.skip_planner is True
        assert path.is_read_only is True
        assert isinstance(path.toolset, ReadOnlyToolset)
    else:
        # R3.1: Agent path, not read-only, planner runs, full toolset, FSM at INTAKE.
        assert isinstance(path, AgentPath)
        assert path.mode is Mode.AGENT
        assert path.skip_planner is False
        assert path.is_read_only is False
        assert isinstance(path.toolset, FullToolset)
        assert isinstance(path.fsm, FSM)
        assert path.fsm.initial is Stage.INTAKE
        assert path.fsm.current is Stage.INTAKE
