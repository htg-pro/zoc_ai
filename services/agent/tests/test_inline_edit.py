"""Inline edit (Cmd-K): rewrite a selection per an instruction via a single
LLM call, returning only the replacement text."""

from __future__ import annotations

from llama_studio_agent.modes.inline_edit import strip_code_fence
from llama_studio_agent.providers.mock import MockResponse


def test_strip_code_fence_unwraps_single_fenced_block():
    assert strip_code_fence("```python\nx = 1\n```") == "x = 1"
    assert strip_code_fence("```\nplain\n```") == "plain"
    # No fence → returned verbatim (including significant indentation).
    assert strip_code_fence("    indented = True") == "    indented = True"
    # Inner triple-backtick content is preserved when not the outer wrapper.
    assert strip_code_fence("const x = 1;") == "const x = 1;"


def test_inline_edit_route_returns_rewritten_selection(client, session, mock_provider):
    mock_provider.reset()
    mock_provider.queue(MockResponse(text="def add(a, b):\n    return a + b"))

    resp = client.post(
        f"/v1/sessions/{session.id}/inline-edit",
        json={
            "selection": "def add(a, b):\n    return a+b",
            "instruction": "add spaces around the operator",
            "language": "python",
            "prefix": "# math helpers\n",
            "suffix": "\n\nprint(add(1, 2))",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["edited"] == "def add(a, b):\n    return a + b"


def test_inline_edit_route_strips_model_code_fence(client, session, mock_provider):
    mock_provider.reset()
    mock_provider.queue(MockResponse(text="```ts\nconst x: number = 1;\n```"))

    resp = client.post(
        f"/v1/sessions/{session.id}/inline-edit",
        json={"selection": "const x = 1", "instruction": "add a type annotation"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["edited"] == "const x: number = 1;"
