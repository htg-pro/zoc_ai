"""ReAct → MCP dispatch wiring (Part 4, task 10.2).

Proves the synchronous ReAct apply loop exposes the aggregated MCP tools to the
model and routes an MCP tool call through the injected ``mcp_call`` sync bridge
(the production bridge schedules the async host on the run's loop; here a fake
bridge returns a scripted outcome so no real subprocess/loop is needed).
"""

from __future__ import annotations

import tempfile
from collections.abc import Mapping

from zocai_gateway.context.mcp_host.models import McpToolRecord
from zocai_gateway.context.mcp_host.registry import namespaced_name
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.edits import EditCoordinator
from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.model_runtime import ModelToolResponse, ToolCall
from zocai_gateway.orchestrator import Orchestrator
from zocai_gateway.permissions import Decision
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.react import ReActExecutor
from zocai_gateway.run_pipeline import RunContext
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset


class _FakeSeam:
    """A toolset MCP seam exposing fixed records (proxy unused by the sync loop)."""

    def __init__(self, records: list[McpToolRecord]) -> None:
        self._records = records

    def list_tools(self) -> list[McpToolRecord]:
        return self._records

    async def proxy(self, namespaced: str, arguments: Mapping[str, object]):  # type: ignore[no-untyped-def]
        raise AssertionError("sync ReAct loop uses mcp_call, not the async proxy")


def _context() -> RunContext:
    return RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, 4000),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(fragments=(), dropped=(), token_count=0, window=4000),
        mcp_tools=(),
    )


def test_react_exposes_and_dispatches_mcp_tools() -> None:
    ns = namespaced_name("web-search", "web_search")
    records = [
        McpToolRecord(
            server_id="web-search",
            bare_name="web_search",
            namespaced_name=ns,
            input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
            description="Search the web",
        )
    ]
    dispatched: list[tuple[str, dict[str, object]]] = []
    permission_calls: list[tuple[str, str, str]] = []

    def check_permission(kind: str, name: str, target: str) -> Decision:
        permission_calls.append((kind, name, target))
        return Decision("allow", "MCP tool is allowlisted.")

    def fake_dispatch(name: str, arguments: Mapping[str, object]) -> tuple[bool, str]:
        dispatched.append((name, dict(arguments)))
        return True, "search-result-text"

    events: list = []
    histories: list[list] = []
    captured: dict[str, list] = {}

    # Step 1: the model calls the MCP tool; step 2: it stops.
    script = iter(
        [
            ModelToolResponse(
                text="",
                tool_calls=(ToolCall(id="m1", name=ns, arguments={"query": "hi"}),),
                finish_reason="tool_calls",
            )
        ]
    )

    def model(request, *, system_prompt, tools, tool_history=(), timeout=120.0):  # type: ignore[no-untyped-def]
        histories.append(list(tool_history))
        captured["specs"] = list(tools)
        try:
            return next(script)
        except StopIteration:
            return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

    with tempfile.TemporaryDirectory() as tmp:
        toolset = FullToolset(tmp, mcp=_FakeSeam(records))
        fsm = FSM(initial=Stage.APPLY_EDITS, run_id="r", emit=events.append)
        orchestrator = Orchestrator(
            fsm=fsm,
            edits=EditCoordinator(toolset=toolset, run_id="r", emit=events.append),
            run_id="r",
            emit=events.append,
        )
        executor = ReActExecutor(
            toolset=toolset,
            orchestrator=orchestrator,
            plan=AgentPlan(
                steps=[EditStep(file="goal.py", action="create", rationale="r")], confidence=1.0
            ),
            request=AgentRunRequest(prompt="research it", mode=Mode.AGENT),
            context=_context(),
            emit=events.append,
            run_id="r",
            run_with_tools=model,
            mcp_call=fake_dispatch,
            check_permission=check_permission,
        )
        executor.run()

    # The MCP tool is presented to the model alongside the native tools.
    spec_names = {getattr(s, "name", None) for s in captured["specs"]}
    assert ns in spec_names
    assert "write_file" in spec_names and "read_file" in spec_names

    # The MCP tool call was permission-checked and audited before dispatch.
    assert permission_calls == [("mcp", ns, ns)]
    permission_events = [event for event in events if event.type == "permission"]
    assert len(permission_events) == 1
    assert permission_events[0].name == ns
    assert permission_events[0].effect == "allow"

    # The MCP tool call routed through the sync bridge with the exact arguments.
    assert dispatched == [(ns, {"query": "hi"})]

    # The observation from the bridge is recorded into the tool history.
    assert any(
        m.get("name") == ns and m.get("content") == "search-result-text" for m in histories[1]
    )


def test_react_without_mcp_presents_no_mcp_tools() -> None:
    captured: dict[str, list] = {}

    def model(request, *, system_prompt, tools, tool_history=(), timeout=120.0):  # type: ignore[no-untyped-def]
        captured["specs"] = list(tools)
        return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

    with tempfile.TemporaryDirectory() as tmp:
        toolset = FullToolset(tmp)  # no MCP seam
        fsm = FSM(initial=Stage.APPLY_EDITS, run_id="r", emit=[].append)
        orchestrator = Orchestrator(
            fsm=fsm,
            edits=EditCoordinator(toolset=toolset, run_id="r", emit=[].append),
            run_id="r",
            emit=[].append,
        )
        ReActExecutor(
            toolset=toolset,
            orchestrator=orchestrator,
            plan=AgentPlan(
                steps=[EditStep(file="a.py", action="create", rationale="r")], confidence=1.0
            ),
            request=AgentRunRequest(prompt="x", mode=Mode.AGENT),
            context=_context(),
            emit=[].append,
            run_id="r",
            run_with_tools=model,
            mcp_call=None,
        ).run()

    spec_names = {getattr(s, "name", None) for s in captured["specs"]}
    assert not any(n and str(n).startswith("mcp::") for n in spec_names)  # no MCP tools presented
