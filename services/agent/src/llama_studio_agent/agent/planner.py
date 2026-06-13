"""Plan synthesis.

The planner asks the model for a structured plan (steps with optional
suggested tool calls). The model is instructed to reply with JSON that
matches `PlanSchema` below. Free-form / partial replies are accepted and
massaged into a best-effort plan.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from shared_schema.models import Plan, PlanStep, PlanStepStatus

from ..providers.base import ChatMessage, ChatRequest, LLMProvider

PLANNER_SYSTEM = (
    "You are the planning module of a coding agent. Given a high-level goal,"
    " produce a JSON plan with the schema"
    " {\"goal\": str, \"steps\": [{\"title\": str, \"detail\"?: str}]}."
    " Keep steps small, ordered, and individually verifiable. Reply with"
    " JSON only — no prose, no Markdown fences."
)


@dataclass(slots=True)
class PlannerOutput:
    plan: Plan
    raw: str


_JSON_BLOCK = re.compile(r"\{[\s\S]*\}")


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = _JSON_BLOCK.search(text)
        if not m:
            raise
        return json.loads(m.group(0))


async def build_plan(
    provider: LLMProvider,
    *,
    model: str,
    goal: str,
    context: str | None = None,
) -> PlannerOutput:
    messages = [ChatMessage(role="system", content=PLANNER_SYSTEM)]
    if context:
        messages.append(ChatMessage(role="user", content=f"Workspace context:\n{context}"))
    messages.append(ChatMessage(role="user", content=f"Goal: {goal}"))
    resp = await provider.chat(ChatRequest(messages=messages, model=model, temperature=0.1))
    try:
        data = _extract_json(resp.text or "{}")
    except json.JSONDecodeError:
        data = {"goal": goal, "steps": [{"title": "Investigate", "detail": resp.text[:200]}]}
    steps = [
        PlanStep(title=s.get("title") or "step", detail=s.get("detail"), status=PlanStepStatus.pending)
        for s in (data.get("steps") or [{"title": "Complete the goal"}])
    ]
    if not steps:
        steps = [PlanStep(title="Complete the goal", status=PlanStepStatus.pending)]
    return PlannerOutput(plan=Plan(goal=data.get("goal") or goal, steps=steps), raw=resp.text)
