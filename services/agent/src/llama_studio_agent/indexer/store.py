"""SQLite-backed vector store with optional ANN acceleration.

Uses sqlite-vec (https://github.com/asg017/sqlite-vec) for fast KNN queries
when available, falling back to brute-force cosine similarity otherwise.
The fallback is sufficient for per-workspace indexes (tens of thousands of
chunks max).
"""

from __future__ import annotations

import json
import logging
import math
import sqlite3
import struct
from collections.abc import Iterable
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

_log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    symbol TEXT,
    text TEXT NOT NULL,
    vector BLOB NOT NULL,
    dim INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# Schema for sqlite-vec mode (created dynamically if extension is available)
VEC_SCHEMA_TEMPLATE = """
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    embedding float[{dim}]
);

CREATE TABLE IF NOT EXISTS chunk_meta (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    file TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    symbol TEXT,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunk_meta_file ON chunk_meta(file);
"""


def _pack(v: list[float]) -> bytes:
    return struct.pack(f"<{len(v)}f", *v)


def _unpack(b: bytes, dim: int) -> list[float]:
    return list(struct.unpack(f"<{dim}f", b))


def _serialize_f32(v: list[float]) -> bytes:
    """Serialize float vector for sqlite-vec (native float32 format)."""
    return struct.pack(f"{len(v)}f", *v)


def _try_load_vec0(conn: sqlite3.Connection) -> bool:
    """Attempt to load the sqlite-vec extension. Returns True if successful."""
    try:
        conn.enable_load_extension(True)
        conn.load_extension("vec0")
        return True
    except (sqlite3.OperationalError, AttributeError):
        return False


class VectorStore:
    def __init__(self, path: str | Path, dim: int | None = None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._use_vec0 = False
        self._dim = dim

        with self._connect() as conn:
            # Try to load sqlite-vec extension
            if _try_load_vec0(conn):
                self._use_vec0 = True
                _log.info("sqlite-vec extension loaded; using ANN queries")
                # Only create vec schema if dim is provided
                if dim is not None:
                    self._ensure_vec_schema(conn, dim)
            else:
                _log.info("sqlite-vec not available; using brute-force cosine similarity")

            # Always ensure base schema exists (for brute-force mode or meta table)
            conn.executescript(SCHEMA)
            conn.commit()

    def _ensure_vec_schema(self, conn: sqlite3.Connection, dim: int) -> None:
        """Ensure vec_chunks table exists with the correct dimension.

        If the table exists but has a different dimension, drop and recreate.
        If migrating from old schema, copy data over.
        """
        # Check current vec_dim
        cursor = conn.execute("SELECT value FROM meta WHERE key = 'vec_dim'")
        row = cursor.fetchone()
        current_dim = int(row["value"]) if row else None

        # Check if vec_chunks exists
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
        )
        vec_exists = cursor.fetchone() is not None

        # Check if old chunks table exists (migration case)
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'"
        )
        old_exists = cursor.fetchone() is not None

        if vec_exists and current_dim == dim:
            # Already set up correctly
            return

        if vec_exists and current_dim != dim:
            # Dim changed — drop and recreate
            _log.info("vector dimension changed %s → %s; recreating vec tables", current_dim, dim)
            conn.execute("DROP TABLE IF EXISTS vec_chunks")
            conn.execute("DELETE FROM chunk_meta")

        # Create vec schema
        conn.executescript(VEC_SCHEMA_TEMPLATE.format(dim=dim))
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('vec_dim', ?)",
            (str(dim),)
        )

        # Migrate from old schema if present
        if old_exists:
            _log.info("migrating from old chunks table to vec_chunks + chunk_meta")
            conn.execute("""
                INSERT INTO chunk_meta (id, file, start_line, end_line, symbol, text)
                SELECT id, file, start_line, end_line, symbol, text FROM chunks
            """)
            # Copy vectors — need to convert from BLOB to vec0 format
            cursor = conn.execute("SELECT rowid, vector, dim FROM chunks ORDER BY rowid")
            for row in cursor:
                vec = _unpack(row["vector"], row["dim"])
                conn.execute(
                    "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
                    (row["rowid"], _serialize_f32(vec))
                )
            conn.execute("DROP TABLE chunks")
            conn.execute("DROP INDEX IF EXISTS idx_chunks_file")
            _log.info("migration complete")

        conn.commit()

    @contextmanager
    def _connect(self):
        with self._lock:
            conn = sqlite3.connect(self.path)
            conn.row_factory = sqlite3.Row
            try:
                yield conn
            finally:
                conn.close()

    def clear_file(self, file: str) -> None:
        with self._connect() as conn:
            if self._use_vec0:
                # Delete from both tables
                cursor = conn.execute("SELECT rowid FROM chunk_meta WHERE file = ?", (file,))
                rowids = [row["rowid"] for row in cursor]
                conn.execute("DELETE FROM chunk_meta WHERE file = ?", (file,))
                for rid in rowids:
                    conn.execute("DELETE FROM vec_chunks WHERE rowid = ?", (rid,))
            else:
                conn.execute("DELETE FROM chunks WHERE file = ?", (file,))
            conn.commit()

    def clear_all(self) -> None:
        with self._connect() as conn:
            if self._use_vec0:
                conn.execute("DELETE FROM vec_chunks")
                conn.execute("DELETE FROM chunk_meta")
            else:
                conn.execute("DELETE FROM chunks")
            conn.commit()

    def upsert(
        self,
        rows: Iterable[dict],
    ) -> int:
        n = 0
        with self._connect() as conn:
            if self._use_vec0:
                for r in rows:
                    vec = r["vector"]
                    # Insert or update metadata
                    conn.execute(
                        "INSERT INTO chunk_meta(id,file,start_line,end_line,symbol,text)"
                        " VALUES (?,?,?,?,?,?)"
                        " ON CONFLICT(id) DO UPDATE SET"
                        " file=excluded.file, start_line=excluded.start_line,"
                        " end_line=excluded.end_line, symbol=excluded.symbol,"
                        " text=excluded.text",
                        (
                            r["id"],
                            r["file"],
                            r["start_line"],
                            r["end_line"],
                            r.get("symbol"),
                            r["text"],
                        ),
                    )
                    # Get the rowid
                    cursor = conn.execute("SELECT rowid FROM chunk_meta WHERE id = ?", (r["id"],))
                    row = cursor.fetchone()
                    if row:
                        rowid = row["rowid"]
                        # Insert or replace vector
                        conn.execute(
                            "INSERT OR REPLACE INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
                            (rowid, _serialize_f32(vec))
                        )
                    n += 1
            else:
                for r in rows:
                    vec = r["vector"]
                    conn.execute(
                        "INSERT INTO chunks(id,file,start_line,end_line,symbol,text,vector,dim)"
                        " VALUES (?,?,?,?,?,?,?,?)"
                        " ON CONFLICT(id) DO UPDATE SET"
                        " file=excluded.file, start_line=excluded.start_line,"
                        " end_line=excluded.end_line, symbol=excluded.symbol,"
                        " text=excluded.text, vector=excluded.vector, dim=excluded.dim",
                        (
                            r["id"],
                            r["file"],
                            r["start_line"],
                            r["end_line"],
                            r.get("symbol"),
                            r["text"],
                            _pack(vec),
                            len(vec),
                        ),
                    )
                    n += 1
            conn.commit()
        return n

    def count(self) -> int:
        with self._connect() as conn:
            if self._use_vec0:
                row = conn.execute("SELECT count(*) AS n FROM chunk_meta").fetchone()
            else:
                row = conn.execute("SELECT count(*) AS n FROM chunks").fetchone()
        return int(row["n"])

    def file_count(self) -> int:
        with self._connect() as conn:
            if self._use_vec0:
                row = conn.execute("SELECT count(DISTINCT file) AS n FROM chunk_meta").fetchone()
            else:
                row = conn.execute("SELECT count(DISTINCT file) AS n FROM chunks").fetchone()
        return int(row["n"])

    def query(self, vector: list[float], top_k: int) -> list[tuple[float, dict]]:
        results: list[tuple[float, dict]] = []

        if self._use_vec0:
            # Use sqlite-vec KNN query
            with self._connect() as conn:
                rows = conn.execute(
                    """
                    SELECT
                        m.id, m.file, m.start_line, m.end_line, m.symbol, m.text,
                        distance
                    FROM vec_chunks v
                    JOIN chunk_meta m ON v.rowid = m.rowid
                    WHERE v.embedding MATCH ?
                    ORDER BY distance
                    LIMIT ?
                    """,
                    (_serialize_f32(vector), top_k)
                ).fetchall()

            for row in rows:
                # sqlite-vec returns L2 distance; convert to cosine similarity
                # For normalized vectors: similarity = 1 - (distance^2 / 2)
                # Approximation: similarity ≈ 1 - distance (close enough for ranking)
                score = 1.0 - float(row["distance"])
                results.append((
                    score,
                    {
                        "id": row["id"],
                        "file": row["file"],
                        "start_line": row["start_line"],
                        "end_line": row["end_line"],
                        "symbol": row["symbol"],
                        "text": row["text"],
                    },
                ))
        else:
            # Brute-force cosine similarity
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id,file,start_line,end_line,symbol,text,vector,dim FROM chunks"
                ).fetchall()
            if not rows:
                return []
            norm_q = math.sqrt(sum(x * x for x in vector)) or 1.0
            q = [x / norm_q for x in vector]
            for row in rows:
                vec = _unpack(row["vector"], row["dim"])
                score = sum(a * b for a, b in zip(q, vec, strict=False))
                results.append(
                    (
                        score,
                        {
                            "id": row["id"],
                            "file": row["file"],
                            "start_line": row["start_line"],
                            "end_line": row["end_line"],
                            "symbol": row["symbol"],
                            "text": row["text"],
                        },
                    )
                )
            results.sort(key=lambda x: x[0], reverse=True)
            results = results[:top_k]

        return results

    def set_meta(self, key: str, value: dict | str) -> None:
        payload = value if isinstance(value, str) else json.dumps(value, default=str)
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO meta(key,value) VALUES (?,?)"
                " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, payload),
            )
            conn.commit()

    def get_meta(self, key: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None
