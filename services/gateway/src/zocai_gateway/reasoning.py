"""Total reasoning/body split for one model response (R6.1-R6.3).

Non-reasoning GGUF models never emit a ``<think>...</think>`` block, so the
previous ANALYZE step — which retried twice for a complete block and then
raised — killed every Agent/Plan run on those models. This module replaces that
fail-closed path with a single **total** function: ``split_reasoning`` returns a
:class:`ReasoningSplit` for *any* input, including the empty string, whitespace,
and text with no block, and never raises. ``""`` reasoning is a valid answer that
advances the Stage_Machine.

The rules mirror the frontend ``splitReasoning`` (``features/agent/reasoning.ts``)
field-for-field, so the Gateway split and the frontend defence-in-depth layer
agree on how a model's private scratchpad is separated from its answer body.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = ["ReasoningSplit", "split_reasoning"]

# `.` with DOTALL matches newlines too, so a multi-line block is captured whole.
# IGNORECASE matches ``<THINK>`` / ``<Think>`` as well. These mirror the
# frontend's `CLOSED_BLOCK` / `DANGLING_BLOCK` regexes exactly.
_CLOSED_BLOCK = re.compile(r"<think>(.*?)</think>", re.IGNORECASE | re.DOTALL)
_DANGLING_BLOCK = re.compile(r"<think>(.*)$", re.IGNORECASE | re.DOTALL)


@dataclass(frozen=True, slots=True)
class ReasoningSplit:
    """The reasoning/body split of one model response (R6.1-R6.3)."""

    reasoning: str
    body: str
    #: True when at least one *complete* ``<think>...</think>`` block was found.
    #: Diagnostics only — no control flow depends on it, which is the whole point
    #: of the rewrite that removed the fail-closed retry. A dangling open tag
    #: (no matching close) is reasoning-so-far, not a complete block, so it does
    #: not set this flag.
    had_block: bool


def split_reasoning(text: str) -> ReasoningSplit:
    """Separate private reasoning from the response body. Total: never raises.

    - Complete block(s)         -> (joined block contents, remaining text)   (R6.1)
    - Dangling open tag         -> (text after the tag, text before the tag)
    - No block, non-empty text  -> ("", text)                                (R6.2)
    - Empty / whitespace text   -> ("", "")                                  (R6.3)

    Block contents and the body are stripped; multiple complete blocks are
    joined with a blank line, matching the frontend split.
    """
    if not text or "<think>" not in text.lower():
        # No opening tag at all: the whole (stripped) input is the body. This is
        # the common non-reasoning-model case (R6.2) and the empty case (R6.3).
        return ReasoningSplit(reasoning="", body=text.strip(), had_block=False)

    blocks: list[str] = []

    def _collect(match: re.Match[str]) -> str:
        blocks.append(match.group(1).strip())
        return ""

    body = _CLOSED_BLOCK.sub(_collect, text)
    had_block = bool(blocks)

    # A remaining open tag with no matching close is reasoning still streaming:
    # everything after it is reasoning-so-far, and the answer is what precedes it.
    dangling = _DANGLING_BLOCK.search(body)
    if dangling is not None:
        blocks.append(dangling.group(1).strip())
        body = body[: dangling.start()]

    reasoning = "\n\n".join(block for block in blocks if block)
    return ReasoningSplit(reasoning=reasoning, body=body.strip(), had_block=had_block)
