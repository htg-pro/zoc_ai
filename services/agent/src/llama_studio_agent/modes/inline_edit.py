"""Inline edit (Cmd-K): rewrite a single code selection per an instruction.

A focused, single-shot LLM call — not the agent tool loop. Given the selected
code (plus optional surrounding context) and an instruction, the model returns
ONLY the rewritten selection, which the frontend splices back into the file and
routes through the normal diff-review/apply flow.
"""

from __future__ import annotations

from shared_schema.models import InlineEditResult

from ..providers.base import ChatMessage, ChatRequest, LLMProvider

INLINE_EDIT_SYSTEM = (
    "You are a precise code-editing assistant inside an IDE. You are given a "
    "code SELECTION from a file and an INSTRUCTION describing how to change it. "
    "Rewrite ONLY the selection so it satisfies the instruction.\n\n"
    "Rules:\n"
    "- Output ONLY the replacement code for the selection. No explanations, no "
    "commentary, and no Markdown code fences.\n"
    "- Preserve the surrounding indentation and the file's language and style.\n"
    "- Keep the change minimal and scoped to the instruction.\n"
    "- If the instruction cannot be applied, return the selection unchanged."
)


def strip_code_fence(text: str) -> str:
    """Defensively unwrap a single Markdown code fence the model may add despite
    instructions (```lang\n...\n```), preserving the inner code verbatim."""
    stripped = text.strip()
    if not stripped.startswith("```"):
        return text
    lines = stripped.split("\n")
    # Drop the opening fence line (``` or ```lang).
    lines = lines[1:]
    # Drop the trailing fence line if present.
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines)


async def run_inline_edit(
    provider: LLMProvider,
    *,
    model: str,
    selection: str,
    instruction: str,
    language: str | None = None,
    prefix: str = "",
    suffix: str = "",
) -> InlineEditResult:
    lang = language or ""
    context_parts: list[str] = []
    if prefix.strip():
        context_parts.append(f"Code immediately BEFORE the selection:\n```{lang}\n{prefix}\n```")
    if suffix.strip():
        context_parts.append(f"Code immediately AFTER the selection:\n```{lang}\n{suffix}\n```")
    context = ("\n\n".join(context_parts) + "\n\n") if context_parts else ""

    user = (
        f"{context}SELECTION to rewrite:\n```{lang}\n{selection}\n```\n\n"
        f"INSTRUCTION: {instruction}\n\n"
        "Return only the rewritten selection (no fences, no prose)."
    )
    resp = await provider.chat(
        ChatRequest(
            messages=[
                ChatMessage(role="system", content=INLINE_EDIT_SYSTEM),
                ChatMessage(role="user", content=user),
            ],
            model=model,
            temperature=0.0,
        )
    )
    return InlineEditResult(edited=strip_code_fence(resp.text or ""))
