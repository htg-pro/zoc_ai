"""Tiny SQLite wrapper. No ORM; small enough to hand-write."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from threading import RLock

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    name TEXT,
    tool_call_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id);

CREATE TABLE IF NOT EXISTS plan_steps (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);

CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    arguments TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

CREATE TABLE IF NOT EXISTS permissions (
    session_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    granted INTEGER NOT NULL,
    note TEXT,
    PRIMARY KEY (session_id, scope),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_grants (
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    granted INTEGER NOT NULL,
    once INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    PRIMARY KEY (session_id, tool),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Phase 3: episodic memory.
-- Running summary of older messages that no longer fit the working window.
-- `covers_up_to_message_id` is the most-recent message included in the summary
-- so we can incrementally extend it without re-summarising the whole transcript.


-- Replit-style plan/task workflow. Additive tables so existing session
-- persistence stays compatible with old databases.
CREATE TABLE IF NOT EXISTS replit_plans (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_replit_plans_session ON replit_plans(session_id);

CREATE TABLE IF NOT EXISTS replit_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    plan_id TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    depends_on TEXT NOT NULL DEFAULT '[]',
    files_likely_changed TEXT NOT NULL DEFAULT '[]',
    done_looks_like TEXT NOT NULL DEFAULT '[]',
    test_plan TEXT NOT NULL DEFAULT '[]',
    workspace_path TEXT,
    diff TEXT,
    test_output TEXT,
    error TEXT,
    validation_attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES replit_plans(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_replit_tasks_session ON replit_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_replit_tasks_plan ON replit_tasks(plan_id);

CREATE TABLE IF NOT EXISTS replit_task_logs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES replit_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_replit_task_logs_task ON replit_task_logs(task_id);

CREATE TABLE IF NOT EXISTS replit_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT,
    label TEXT NOT NULL,
    snapshot_path TEXT NOT NULL,
    files TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES replit_tasks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_replit_checkpoints_session ON replit_checkpoints(session_id);

CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    covers_up_to_message_id TEXT NOT NULL,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
"""


class Database:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        with self.connect() as conn:
            # WAL gives us reader-writer concurrency: readers don't block on
            # the writer, which matters when an SSE stream is hydrating a
            # session while an agent run is appending events. NORMAL sync
            # is the standard tradeoff (durable on power loss for committed
            # transactions, faster than FULL).
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.executescript(SCHEMA)
            # Additive migrations: safe to re-run on existing databases.
            for stmt in (
                "ALTER TABLE replit_tasks ADD COLUMN validation_attempts INTEGER NOT NULL DEFAULT 0",
            ):
                with suppress(sqlite3.OperationalError):
                    conn.execute(stmt)
            conn.commit()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            try:
                yield conn
            finally:
                conn.close()
