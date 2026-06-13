"""Code review mode.

Takes either a raw unified diff or a list of changed files, asks the LLM
for structured findings (severity, location, message, optional suggestion
patch), and returns a `CodeReviewReport`.
"""

from __future__ import annotations

import json
import re
from typing import Any

from shared_schema.models import (
    CodeReviewFinding,
    CodeReviewReport,
    DiffPatch,
    FindingSeverity,
)

from ..agent.planner import _extract_json
from ..providers.base import ChatMessage, ChatRequest, LLMProvider

REVIEWER_SYSTEM = (
    "You are a senior code reviewer. Given a unified diff or file excerpts,"
    " produce JSON matching the CodeReviewReport schema:"
    " {\"summary\": str, \"findings\": [{\"file\": str, \"line\": int,"
    " \"severity\": \"info|low|medium|high|critical\", \"message\": str,"
    " \"suggestion\"?: str, \"patch\"?: {\"file_path\": str, \"unified_diff\": str}}]}."
    " Reply with JSON only."
)


_VALID_SEVERITY = {s.value for s in FindingSeverity}


def _normalise(raw: dict[str, Any]) -> CodeReviewReport:
    findings = []
    for f in raw.get("findings", []) or []:
        sev = (f.get("severity") or "info").lower()
        if sev not in _VALID_SEVERITY:
            sev = "info"
        patch = None
        raw_patch = f.get("patch")
        if isinstance(raw_patch, dict) and raw_patch.get("unified_diff"):
            patch = DiffPatch(
                file_path=raw_patch.get("file_path") or f.get("file", ""),
                unified_diff=raw_patch["unified_diff"],
                summary=raw_patch.get("summary"),
            )
        findings.append(
            CodeReviewFinding(
                file=f.get("file") or "",
                line=int(f.get("line") or 1),
                severity=FindingSeverity(sev),
                message=f.get("message") or "",
                suggestion=f.get("suggestion"),
                patch=patch,
            )
        )
    return CodeReviewReport(summary=raw.get("summary"), findings=findings)


async def run_code_review(
    provider: LLMProvider,
    *,
    model: str,
    diff: str | None = None,
    excerpts: list[tuple[str, str]] | None = None,
) -> CodeReviewReport:
    body_parts: list[str] = []
    if diff:
        body_parts.append("Unified diff:\n```diff\n" + diff + "\n```")
    for path, src in excerpts or []:
        body_parts.append(f"File `{path}`:\n```\n{src}\n```")
    if not body_parts:
        raise ValueError("either diff or excerpts must be provided")
    resp = await provider.chat(
        ChatRequest(
            messages=[
                ChatMessage(role="system", content=REVIEWER_SYSTEM),
                ChatMessage(role="user", content="\n\n".join(body_parts)),
            ],
            model=model,
            temperature=0.0,
        )
    )
    try:
        raw = _extract_json(resp.text or "{}")
    except json.JSONDecodeError:
        raw = {"findings": [], "summary": resp.text}
    return _normalise(raw)


_FILE_LINE_RE = re.compile(r"^([^\s:]+):(\d+):", re.MULTILINE)


def findings_from_lint_output(text: str, *, severity: FindingSeverity = FindingSeverity.low) -> list[CodeReviewFinding]:
    """Cheap helper: convert linter-style `path:line: message` lines into
    `CodeReviewFinding`s. Used for fast-path zero-LLM reviews."""

    out: list[CodeReviewFinding] = []
    for match in _FILE_LINE_RE.finditer(text):
        file, line = match.group(1), int(match.group(2))
        rest = text[match.end():].splitlines()[0].strip() if match.end() < len(text) else ""
        out.append(
            CodeReviewFinding(
                file=file, line=line, severity=severity, message=rest or "lint finding"
            )
        )
    return out
