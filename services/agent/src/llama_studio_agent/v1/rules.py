"""Project rules (.zoc/rules) — read endpoint for the UI indicator."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from shared_schema.models import ProjectRulesInfo, Session

from ..agent.project_rules import collect_rule_sources, load_project_rules
from ..deps import get_session

router = APIRouter(prefix="/sessions/{session_id}", tags=["rules"])


@router.get("/rules", response_model=ProjectRulesInfo)
async def project_rules(session: Session = Depends(get_session)) -> ProjectRulesInfo:
    root = session.workspace_root or ""
    if not root:
        return ProjectRulesInfo(active=False, sources=[], rules="")
    sources = collect_rule_sources(root)
    return ProjectRulesInfo(
        active=bool(sources),
        sources=[label for label, _ in sources],
        rules=load_project_rules(root),
    )
