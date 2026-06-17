"""Phase 4 semantic recall: per-session vector store for chat messages.

Older messages dropped from the working window can still be useful: the
user might ask a follow-up that depends on a fact buried 80 turns ago.
Phase 3's running summary captures the gist; this module captures the
specifics by embedding each dropped message and letting the orchestrator
retrieve the top-k most relevant rows for the current prompt.

Design choices:
  - One SQLite file per session (alongside the main DB), so deleting a
    session truly forgets it without GC'ing a global vector store.
  - Reuse the existing `Embedder` / `HashEmbedder` interface — keeps the
    runtime dependency-free in tests and in browser-preview deployments.
  - Brute-force cosine similarity (same as the workspace indexer) — at the
    scales we expect (a few hundred messages per session) the linear scan
    is faster than maintaining an ANN index.
  - All operations are best-effort: a recall failure must never break a
    turn. We wrap the entry points in try/except at call sites.
"""

from __future__ import annotations

import math
import sqlite3
import struct
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from uuid import UUID

from shared_schema.models import Message

from ..indexer.embeddings import Embedder, HashEmbedder

SCHEMA = """
CREATE TABLE IF NOT EXISTS message_vectors (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    vector BLOB NOT NULL,
    dim INTEGER NOT NULL,
    PRIMARY KEY (session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_vectors_session ON message_vectors(session_id);
"""


def _pack(v: list[float]) -> bytes:
    return struct.pack(f"<{len(v)}f", *v)


def _unpack(b: bytes, dim: int) -> list[float]:
    return list(struct.unpack(f"<{dim}f", b))


@dataclass(slots=True)
class RecallHit:
    """One retrieved message + its similarity score."""

    message_id: UUID
    role: str
    content: str
    score: float


class MessageVectorStore:
    """SQLite-backed per-process store. One file across all sessions; the
    primary key includes ``session_id`` so cross-session leakage is
    impossible by construction.

    Deliberately lives in its own file (``recall.sqlite`` next to the main
    DB) to keep the schema and lifecycle separate — clearing recall data
    must not touch the canonical message log.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)
            conn.commit()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.path)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
            finally:
                conn.close()

    def upsert_many(
        self,
        session_id: UUID,
        rows: list[tuple[Message, list[float]]],
    ) -> int:
        """Insert or replace ``(message, vector)`` pairs for one session."""
        if not rows:
            return 0
        with self._connect() as conn:
            for msg, vec in rows:
                conn.execute(
                    "INSERT INTO message_vectors"
                    " (session_id, message_id, role, content, created_at, vector, dim)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT(session_id, message_id) DO UPDATE SET"
                    "  role=excluded.role, content=excluded.content,"
                    "  created_at=excluded.created_at,"
                    "  vector=excluded.vector, dim=excluded.dim",
                    (
                        str(session_id),
                        str(msg.id),
                        msg.role.value,
                        msg.content,
                        msg.created_at.isoformat(),
                        _pack(vec),
                        len(vec),
                    ),
                )
            conn.commit()
        return len(rows)

    def query(
        self,
        session_id: UUID,
        vector: list[float],
        top_k: int,
        *,
        exclude_message_ids: set[UUID] | None = None,
    ) -> list[RecallHit]:
        """Top-k cosine similarity within one session.

        ``exclude_message_ids`` lets the caller skip messages already
        in the working window so recall doesn't return what's already
        in the prompt verbatim.

        Guarantees (Requirements 4.1, 4.2, 4.4, 4.5):
          - Session isolation (4.1): rows are selected with
            ``WHERE session_id = ?``, so only vectors stored under
            ``session_id`` are ever scored — cross-session leakage is
            impossible by construction (the primary key includes
            ``session_id``).
          - Working-window exclusion (4.2): every ``message_id`` in
            ``exclude_message_ids`` is skipped and never appears in the
            result.
          - top_k cap + ordering: hits are sorted by descending score and
            truncated to at most ``top_k`` entries.
          - top_k short-circuit: returns ``[]`` immediately when
            ``top_k <= 0`` (no query work, no hits).
        """
        if top_k <= 0:
            return []
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT message_id, role, content, vector, dim"
                " FROM message_vectors WHERE session_id = ?",
                (str(session_id),),
            ).fetchall()
        if not rows:
            return []
        norm_q = math.sqrt(sum(x * x for x in vector)) or 1.0
        q = [x / norm_q for x in vector]
        excluded = {str(uid) for uid in (exclude_message_ids or set())}
        scored: list[RecallHit] = []
        for row in rows:
            if row["message_id"] in excluded:
                continue
            vec = _unpack(row["vector"], row["dim"])
            score = sum(a * b for a, b in zip(q, vec, strict=False))
            scored.append(
                RecallHit(
                    message_id=UUID(row["message_id"]),
                    role=row["role"],
                    content=row["content"],
                    score=float(score),
                )
            )
        scored.sort(key=lambda h: h.score, reverse=True)
        return scored[:top_k]

    def clear_session(self, session_id: UUID) -> int:
        """Drop every vector for a session — used by `/forget` and the
        reload menu. Returns rows deleted."""
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM message_vectors WHERE session_id = ?",
                (str(session_id),),
            )
            n = cur.rowcount
            conn.commit()
        return int(n)

    def known_message_ids(self, session_id: UUID) -> set[UUID]:
        """Set of message ids already embedded for this session — lets the
        caller skip work it's already done."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT message_id FROM message_vectors WHERE session_id = ?",
                (str(session_id),),
            ).fetchall()
        return {UUID(r["message_id"]) for r in rows}


@dataclass(slots=True)
class RecallConfig:
    top_k: int = 3
    """How many recall hits to inject per turn."""

    min_score: float = 0.15
    """Cosine-similarity floor. Hits below this are ignored — recall
    quality matters more than quantity."""

    snippet_chars: int = 600
    """Truncate each recalled message's content to this many characters
    when injecting into history. Long tool results otherwise blow the
    budget that recall was supposed to save."""


class RecallService:
    """High-level facade. The orchestrator holds one of these per process.

    Responsibilities:
      - On dropped messages: embed them and persist to the vector store.
      - On a new turn: embed the current prompt and return top-k matches.

    Embedding failures degrade silently — the store stays consistent
    because we only commit when embedding succeeds.
    """

    def __init__(
        self,
        *,
        store: MessageVectorStore,
        embedder: Embedder | None = None,
    ) -> None:
        self.store = store
        self.embedder = embedder or HashEmbedder()

    async def index_messages(
        self,
        session_id: UUID,
        messages: list[Message],
    ) -> int:
        """Embed and persist messages whose id we haven't seen yet for
        this session. Returns rows written."""
        if not messages:
            return 0
        already = self.store.known_message_ids(session_id)
        fresh = [m for m in messages if m.id not in already and m.content]
        if not fresh:
            return 0
        try:
            vectors = await self.embedder.embed([m.content for m in fresh])
        except Exception:
            return 0
        if not vectors or len(vectors) != len(fresh):
            return 0
        return self.store.upsert_many(session_id, list(zip(fresh, vectors, strict=True)))

    async def recall(
        self,
        session_id: UUID,
        query: str,
        *,
        cfg: RecallConfig | None = None,
        exclude_message_ids: set[UUID] | None = None,
    ) -> list[RecallHit]:
        """Top-k relevant prior messages for ``query`` in ``session_id``.

        Guarantees (Requirements 4.2, 4.3, 4.4, 4.5):
          - Empty-query short-circuit: returns ``[]`` when ``query`` is
            empty or whitespace-only (``query.strip()`` is falsy).
          - min_score floor: every returned hit has
            ``score >= cfg.min_score`` (default 0.15); lower-scoring hits
            are dropped.
          - top_k cap (default 3) and descending-score ordering, plus the
            ``top_k <= 0`` short-circuit, are enforced by
            ``MessageVectorStore.query``.
          - Working-window exclusion (``exclude_message_ids``) and session
            isolation are likewise delegated to the store, so no excluded
            or cross-session message can surface here.
        """
        if not query.strip():
            return []
        cfg = cfg or RecallConfig()
        try:
            qvec = (await self.embedder.embed([query]))[0]
        except Exception:
            return []
        hits = self.store.query(
            session_id,
            qvec,
            cfg.top_k,
            exclude_message_ids=exclude_message_ids,
        )
        out: list[RecallHit] = []
        for h in hits:
            if h.score < cfg.min_score:
                continue
            content = h.content
            if len(content) > cfg.snippet_chars:
                content = content[: cfg.snippet_chars] + "…"
            out.append(
                RecallHit(
                    message_id=h.message_id,
                    role=h.role,
                    content=content,
                    score=h.score,
                )
            )
        return out

    def clear_session(self, session_id: UUID) -> int:
        return self.store.clear_session(session_id)


def hits_as_chat_message_content(hits: list[RecallHit]) -> str:
    """Render recall hits into a single system-message body the
    orchestrator can prepend to history."""
    if not hits:
        return ""
    lines = ["[Relevant prior turns recalled from earlier in this session]"]
    for i, h in enumerate(hits, 1):
        lines.append(f"{i}. [{h.role}] {h.content}")
    return "\n".join(lines)
