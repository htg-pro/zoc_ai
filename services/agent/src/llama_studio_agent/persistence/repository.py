"""High-level CRUD over the SQLite schema. Returns shared-schema models."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID


def _now() -> datetime:
    """Timezone-aware UTC `now`. Replaces ``datetime.utcnow()`` which is
    deprecated in 3.12 and slated for removal in 3.13."""
    return datetime.now(UTC)

from shared_schema.models import (
    Message,
    MessageRole,
    PermissionGrant,
    PermissionScope,
    Plan,
    PlanStep,
    PlanStepStatus,
    Session,
    SessionStatus,
    ToolCall,
    ToolCallStatus,
    ToolGrant,
)

from .db import Database


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _from_iso(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


class SessionRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    # ── sessions ────────────────────────────────────────────────────────

    def create_session(self, session: Session) -> Session:
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO sessions(id,title,status,workspace_root,provider,model,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (
                    str(session.id),
                    session.title,
                    session.status.value,
                    session.workspace_root,
                    session.provider,
                    session.model,
                    _iso(session.created_at),
                    _iso(session.updated_at),
                ),
            )
            conn.commit()
        return session

    def list_sessions(self) -> list[Session]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY datetime(updated_at) DESC"
            ).fetchall()
        return [self._hydrate_session(r, include_children=False) for r in rows]

    def get_session(self, session_id: UUID) -> Session | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (str(session_id),)
            ).fetchone()
            if not row:
                return None
            return self._hydrate_session(row, include_children=True, conn=conn)

    def delete_session(self, session_id: UUID) -> bool:
        with self.db.connect() as conn:
            cur = conn.execute("DELETE FROM sessions WHERE id = ?", (str(session_id),))
            conn.commit()
        return cur.rowcount > 0

    def touch(self, session_id: UUID) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                (_iso(_now()), str(session_id)),
            )
            conn.commit()

    def update_workspace_root(self, session_id: UUID, workspace_root: str) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE sessions SET workspace_root = ?, updated_at = ? WHERE id = ?",
                (workspace_root, _iso(_now()), str(session_id)),
            )
            conn.commit()

    def update_status(self, session_id: UUID, status: SessionStatus) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
                (status.value, _iso(_now()), str(session_id)),
            )
            conn.commit()

    # ── messages ────────────────────────────────────────────────────────

    def add_message(self, session_id: UUID, message: Message) -> Message:
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO messages(id,session_id,role,content,name,tool_call_id,created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (
                    str(message.id),
                    str(session_id),
                    message.role.value,
                    message.content,
                    message.name,
                    str(message.tool_call_id) if message.tool_call_id else None,
                    _iso(message.created_at),
                ),
            )
            conn.commit()
        self.touch(session_id)
        return message

    def list_messages(self, session_id: UUID) -> list[Message]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY datetime(created_at)",
                (str(session_id),),
            ).fetchall()
        return [self._row_to_message(r) for r in rows]

    # ── plans ───────────────────────────────────────────────────────────

    def save_plan(self, session_id: UUID, plan: Plan) -> Plan:
        with self.db.connect() as conn:
            conn.execute("DELETE FROM plans WHERE session_id = ?", (str(session_id),))
            conn.execute(
                "INSERT INTO plans(id,session_id,goal,created_at) VALUES (?,?,?,?)",
                (str(plan.id), str(session_id), plan.goal, _iso(plan.created_at)),
            )
            for i, step in enumerate(plan.steps):
                conn.execute(
                    "INSERT INTO plan_steps(id,plan_id,seq,title,detail,status,attempt,error,done)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        str(step.id),
                        str(plan.id),
                        i,
                        step.title,
                        step.detail,
                        step.status.value,
                        step.attempt,
                        step.error,
                        1 if step.done else 0,
                    ),
                )
            conn.commit()
        return plan

    def get_plan(self, session_id: UUID) -> Plan | None:
        with self.db.connect() as conn:
            prow = conn.execute(
                "SELECT * FROM plans WHERE session_id = ?", (str(session_id),)
            ).fetchone()
            if not prow:
                return None
            steps = conn.execute(
                "SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY seq",
                (prow["id"],),
            ).fetchall()
        return Plan(
            id=UUID(prow["id"]),
            goal=prow["goal"],
            created_at=_from_iso(prow["created_at"]) or _now(),
            steps=[
                PlanStep(
                    id=UUID(s["id"]),
                    title=s["title"],
                    detail=s["detail"],
                    status=PlanStepStatus(s["status"]),
                    attempt=int(s["attempt"]),
                    error=s["error"],
                    done=bool(s["done"]),
                )
                for s in steps
            ],
        )

    # ── tool calls ──────────────────────────────────────────────────────

    def upsert_tool_call(self, session_id: UUID, call: ToolCall) -> ToolCall:
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO tool_calls(id,session_id,name,arguments,status,result,error,started_at,finished_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET status=excluded.status,"
                " result=excluded.result, error=excluded.error,"
                " started_at=excluded.started_at, finished_at=excluded.finished_at",
                (
                    str(call.id),
                    str(session_id),
                    call.name,
                    json.dumps(call.arguments),
                    call.status.value,
                    json.dumps(call.result) if call.result is not None else None,
                    call.error,
                    _iso(call.started_at) if call.started_at else None,
                    _iso(call.finished_at) if call.finished_at else None,
                ),
            )
            conn.commit()
        return call

    def list_tool_calls(self, session_id: UUID) -> list[ToolCall]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM tool_calls WHERE session_id = ? ORDER BY datetime(coalesce(started_at, ''))",
                (str(session_id),),
            ).fetchall()
        return [self._row_to_tool_call(r) for r in rows]

    def get_tool_call(self, session_id: UUID, call_id: UUID) -> ToolCall | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM tool_calls WHERE session_id = ? AND id = ?",
                (str(session_id), str(call_id)),
            ).fetchone()
        return self._row_to_tool_call(row) if row else None

    def list_tool_calls_by_status(
        self, status: ToolCallStatus
    ) -> list[tuple[UUID, ToolCall]]:
        """Every tool call in `status` across all sessions, paired with its
        session id. Used to reconcile suspended approvals after a restart.
        """

        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM tool_calls WHERE status = ?",
                (status.value,),
            ).fetchall()
        return [(UUID(r["session_id"]), self._row_to_tool_call(r)) for r in rows]

    # ── permissions ─────────────────────────────────────────────────────

    def set_permission(self, session_id: UUID, grant: PermissionGrant) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO permissions(session_id,scope,granted,note) VALUES (?,?,?,?)"
                " ON CONFLICT(session_id,scope) DO UPDATE SET granted=excluded.granted, note=excluded.note",
                (str(session_id), grant.scope.value, 1 if grant.granted else 0, grant.note),
            )
            conn.commit()

    def get_permissions(self, session_id: UUID) -> list[PermissionGrant]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM permissions WHERE session_id = ?", (str(session_id),)
            ).fetchall()
        return [
            PermissionGrant(
                scope=PermissionScope(r["scope"]), granted=bool(r["granted"]), note=r["note"]
            )
            for r in rows
        ]

    # ── per-tool grants ─────────────────────────────────────────────────

    def set_tool_grant(self, session_id: UUID, grant: ToolGrant) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO tool_grants(session_id,tool,granted,once,note) VALUES (?,?,?,?,?)"
                " ON CONFLICT(session_id,tool) DO UPDATE SET"
                " granted=excluded.granted, once=excluded.once, note=excluded.note",
                (
                    str(session_id),
                    grant.tool,
                    1 if grant.granted else 0,
                    1 if grant.once else 0,
                    grant.note,
                ),
            )
            conn.commit()

    def get_tool_grants(self, session_id: UUID) -> list[ToolGrant]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM tool_grants WHERE session_id = ?", (str(session_id),)
            ).fetchall()
        return [
            ToolGrant(
                tool=r["tool"],
                granted=bool(r["granted"]),
                once=bool(r["once"]),
                note=r["note"],
            )
            for r in rows
        ]

    def delete_tool_grant(self, session_id: UUID, tool: str) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "DELETE FROM tool_grants WHERE session_id = ? AND tool = ?",
                (str(session_id), tool),
            )
            conn.commit()

    # ── episodic summaries (Phase 3 memory) ─────────────────────────────

    def get_summary(self, session_id: UUID) -> dict[str, Any] | None:
        """Return ``{summary, covers_up_to_message_id, token_estimate, updated_at}``
        for the session, or ``None`` if no summary has been written yet."""
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT summary, covers_up_to_message_id, token_estimate, updated_at"
                " FROM session_summaries WHERE session_id = ?",
                (str(session_id),),
            ).fetchone()
        if row is None:
            return None
        return {
            "summary": row["summary"],
            "covers_up_to_message_id": row["covers_up_to_message_id"],
            "token_estimate": int(row["token_estimate"] or 0),
            "updated_at": row["updated_at"],
        }

    def upsert_summary(
        self,
        session_id: UUID,
        *,
        summary: str,
        covers_up_to_message_id: UUID,
        token_estimate: int,
    ) -> None:
        """Atomic write of the running episodic summary."""
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO session_summaries"
                " (session_id, summary, covers_up_to_message_id, token_estimate, updated_at)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT(session_id) DO UPDATE SET"
                "  summary = excluded.summary,"
                "  covers_up_to_message_id = excluded.covers_up_to_message_id,"
                "  token_estimate = excluded.token_estimate,"
                "  updated_at = excluded.updated_at",
                (
                    str(session_id),
                    summary,
                    str(covers_up_to_message_id),
                    int(token_estimate),
                    _iso(_now()),
                ),
            )
            conn.commit()

    def clear_summary(self, session_id: UUID) -> None:
        """Drop the running summary — used by `/forget` and the reload menu."""
        with self.db.connect() as conn:
            conn.execute(
                "DELETE FROM session_summaries WHERE session_id = ?",
                (str(session_id),),
            )
            conn.commit()

    # ── events ──────────────────────────────────────────────────────────

    def append_event(self, session_id: UUID, seq: int, type_: str, payload: dict[str, Any]) -> None:
        with self.db.connect() as conn:
            conn.execute(
                "INSERT INTO events(session_id,seq,type,payload,at) VALUES (?,?,?,?,?)",
                (
                    str(session_id),
                    seq,
                    type_,
                    json.dumps(payload, default=str),
                    _iso(_now()),
                ),
            )
            conn.commit()

    def max_event_seq(self, session_id: UUID) -> int:
        """Highest persisted event seq for a session (0 if none).

        Used to re-seed the in-memory event-bus counter after a restart so new
        events stay above what clients have already replayed.
        """

        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT MAX(seq) AS m FROM events WHERE session_id = ?",
                (str(session_id),),
            ).fetchone()
        return int(row["m"]) if row and row["m"] is not None else 0

    def list_events(self, session_id: UUID, since_seq: int = 0) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT seq,type,payload,at FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
                (str(session_id), since_seq),
            ).fetchall()
        return [
            {"seq": r["seq"], "type": r["type"], "payload": json.loads(r["payload"]), "at": r["at"]}
            for r in rows
        ]


    def _hydrate_session(self, row: Any, *, include_children: bool, conn: Any = None) -> Session:
        sid = UUID(row["id"])
        session = Session(
            id=sid,
            title=row["title"],
            status=SessionStatus(row["status"]),
            workspace_root=row["workspace_root"],
            provider=row["provider"],
            model=row["model"],
            created_at=_from_iso(row["created_at"]) or _now(),
            updated_at=_from_iso(row["updated_at"]) or _now(),
        )
        if include_children:
            session.messages = self.list_messages(sid)
            session.plan = self.get_plan(sid)
            session.tool_calls = self.list_tool_calls(sid)
        return session

    @staticmethod
    def _row_to_message(r: Any) -> Message:
        return Message(
            id=UUID(r["id"]),
            role=MessageRole(r["role"]),
            content=r["content"],
            name=r["name"],
            tool_call_id=UUID(r["tool_call_id"]) if r["tool_call_id"] else None,
            created_at=_from_iso(r["created_at"]) or _now(),
        )

    @staticmethod
    def _row_to_tool_call(r: Any) -> ToolCall:
        return ToolCall(
            id=UUID(r["id"]),
            name=r["name"],
            arguments=json.loads(r["arguments"]),
            status=ToolCallStatus(r["status"]),
            result=json.loads(r["result"]) if r["result"] else None,
            error=r["error"],
            started_at=_from_iso(r["started_at"]),
            finished_at=_from_iso(r["finished_at"]),
        )
