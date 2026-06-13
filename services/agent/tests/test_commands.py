"""One smoke test per slash command, plus registry sanity."""

import pytest
from llama_studio_agent.agent.orchestrator import AgentOrchestrator
from llama_studio_agent.providers.mock import MockResponse
from shared_schema.models import SlashCommandName


def _orch(app_state, session):
    return AgentOrchestrator(
        provider=app_state.providers.get("mock"),
        model="mock-1",
        registry=app_state.tools,
        repo=app_state.repo,
        bus=app_state.bus,
        indexer=app_state.indexer_for(session.id, session.workspace_root),
        permissions=app_state.permissions,
    )


def test_registry_has_seven_commands(app_state):
    names = {d.name for d in app_state.commands.list()}
    assert names == {n for n in SlashCommandName}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,args",
    [
        (SlashCommandName.review, {"target": "src/hello.py"}),
        (SlashCommandName.explain, {"target": "src/hello.py"}),
        (SlashCommandName.fix, {"query": "things break"}),
        (SlashCommandName.refactor, {"target": "src/hello.py"}),
        (SlashCommandName.docs, {"target": "src/hello.py"}),
        (SlashCommandName.grok, {"query": "what does greet do?"}),
        (SlashCommandName.test, {"target": "src/hello.py"}),
    ],
)
async def test_slash_command_smoke(app_state, session, mock_provider, name, args):
    # Each command needs (optionally) a planner reply + one assistant reply.
    # 4 queued responses is enough headroom for the skip-planner and planning
    # variants alike (out-of-script responses fall through to default text).
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"do it"}]}'),
        MockResponse(text="finished."),
        MockResponse(text="finished."),
        MockResponse(text="finished."),
    )
    orch = _orch(app_state, session)
    result = await app_state.commands.run(
        name=name,
        args=args,
        orchestrator=orch,
        session_id=session.id,
        workspace_root=session.workspace_root,
    )
    assert isinstance(result.final_text, str)
