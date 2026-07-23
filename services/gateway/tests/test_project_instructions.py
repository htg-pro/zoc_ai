from pathlib import Path

from zocai_gateway.context.project_instructions import (
    prepend_project_instructions,
    read_project_instructions,
)
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentRunRequest, AskContext, build_ask_context
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.run_pipeline import (
    RunContext,
    RunPipeline,
    _agent_system_prompt,
    _ask_system_prompt,
)


def _write_instructions(root: Path, content: str) -> None:
    path = root / ".zoc" / "instructions.md"
    path.parent.mkdir(parents=True)
    path.write_text(content, encoding="utf-8")


def test_reads_only_workspace_root_instructions(tmp_path: Path) -> None:
    nested = tmp_path / "packages" / "app"
    _write_instructions(nested, "Ignore nested instructions")

    assert read_project_instructions(tmp_path) == ""

    _write_instructions(tmp_path, "Always use tabs.\n")
    assert read_project_instructions(tmp_path) == "Always use tabs."


def test_unreadable_instructions_do_not_block_a_run(tmp_path: Path) -> None:
    path = tmp_path / ".zoc" / "instructions.md"
    path.mkdir(parents=True)

    assert read_project_instructions(tmp_path) == ""


def test_ask_context_loads_workspace_instructions(tmp_path: Path) -> None:
    _write_instructions(tmp_path, "Never use semicolons.")

    context = build_ask_context("Explain this", workspace_root=tmp_path)

    assert context.project_instructions == "Never use semicolons."


def test_agent_context_loads_workspace_instructions(tmp_path: Path) -> None:
    _write_instructions(tmp_path, "Always use tabs.")
    pipeline = RunPipeline(
        AgentRunRequest(prompt="Implement this", mode="agent"),
        "instructions-run",
        gate=EmitGate(sink=lambda _event: None),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
    )

    context = pipeline._build_context(Allocation(ModelTier.LOCAL_SLM, 4000))

    assert context.project_instructions == "Always use tabs."


def test_project_instructions_precede_built_in_prompts() -> None:
    instructions = "Follow SOLID."
    ask_context = AskContext(
        steering=SteeringPayload(), project_instructions=instructions
    )
    agent_context = RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, 4000),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(
            fragments=(), dropped=(), token_count=0, window=4000
        ),
        mcp_tools=(),
        project_instructions=instructions,
    )

    assert _ask_system_prompt(ask_context).startswith(
        "Follow SOLID.\n\nYou are Zoc Ask"
    )
    assert _agent_system_prompt(agent_context).startswith(
        "Follow SOLID.\n\nYou are Zoc Agent"
    )
    assert prepend_project_instructions("base", "  ") == "base"
