"""Property test for AgentPlan schema and path-safety enforcement (Epic 2).

Feature: agent-reasoning-engine, Property 6.

**Validates: Requirements 3.4, 3.5, 3.6**
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import ValidationError
from zocai_gateway.plan import AgentPlan

_VALID_FILES = st.sampled_from(
    ["a.py", "src/b.py", "dir/sub/c.txt", "x", "a/b/c/d.md", "pkg/mod.py"]
)
# Empty, whitespace-only, absolute, or parent-escaping paths are all rejected.
_INVALID_FILES = st.sampled_from(
    ["", "   ", "/abs/path", "../escape", "a/../b", "..", "/", "\t"]
)
_VALID_ACTIONS = st.sampled_from(["create", "modify", "delete", "rename"])
_INVALID_ACTIONS = st.sampled_from(["CREATE", "append", "", "read", "renamed"])
_RATIONALES = st.text(max_size=30)


@st.composite
def _candidate_plan(draw: st.DrawFn) -> tuple[dict, bool]:
    valid = True

    if draw(st.booleans()):
        confidence = draw(st.floats(min_value=0, max_value=1, allow_nan=False))
    else:
        confidence = draw(st.sampled_from([-0.1, 1.5, 2.0, -1.0, 100.0]))
        valid = False

    steps: list[dict] = []
    for _ in range(draw(st.integers(min_value=0, max_value=4))):
        step: dict = {}
        if draw(st.booleans()):
            step["file"] = draw(_VALID_FILES)
        else:
            step["file"] = draw(_INVALID_FILES)
            valid = False
        if draw(st.booleans()):
            step["action"] = draw(_VALID_ACTIONS)
        else:
            step["action"] = draw(_INVALID_ACTIONS)
            valid = False
        if draw(st.booleans()):
            step["rationale"] = draw(_RATIONALES)
        else:
            # Omitting the required rationale makes the step ill-formed.
            valid = False
        steps.append(step)

    return {"steps": steps, "confidence": confidence}, valid


@settings(max_examples=300)
@given(_candidate_plan())
def test_agent_plan_schema_and_path_safety(case: tuple[dict, bool]) -> None:
    """Property 6: AgentPlan validation accepts iff every constraint holds.

    A plan validates only when its confidence is in [0, 1] and every step is a
    well-formed EditStep (valid action, present rationale, workspace-relative
    non-empty non-``..`` path); any violation is rejected.

    Feature: agent-reasoning-engine, Property 6

    **Validates: Requirements 3.4, 3.5, 3.6**
    """
    candidate, expected_valid = case
    try:
        AgentPlan.model_validate(candidate)
        accepted = True
    except ValidationError:
        accepted = False
    assert accepted is expected_valid
