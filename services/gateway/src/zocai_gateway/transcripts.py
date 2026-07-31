"""Durable Session metadata and transcripts — zoc-agent-chat-rebuild R15.2, R15.6, R23.5.

The store the design assumed existed. `SessionRegistry` held sessions in a dict
and there was no transcript store at all, so `GET /v1/sessions/{id}/messages`
answered 404 and the Agent_Runtime's composition root documented the consequence
in its header: every Run was single-turn, because the port that loads prior turns
had nothing to load them from.

Two things live here, in one module because they share a directory layout and a
failure model:

1. **Session metadata** (`session.json`) — id, title, status, workspace root,
   provider, model, timestamps. Never the transcript: R2.4 keeps part data out of
   the metadata row, and R15.11's archive is a status write that must not rewrite
   a single message.
2. **The transcript** (`messages.json`) — the Chat_Surface's UI messages, stored
   verbatim.

## Why the transcript is opaque JSON

A stored message is an AI SDK `UIMessage`: native parts (`text`, `reasoning`, one
per tool call), the eight `data-zoc-*` parts, and the per-Run metadata
`ZocMessageMetadata`. That union is the SDK's and the Chat_Surface's, and it has
no Python mirror by design — R2.2 forbids one app importing another's source, and
mirroring it here would mean a second definition that drifts the first time the
SDK adds a part kind.

So this store validates the *envelope* it has to index by — a string `id`, one of
the four roles, a `parts` list — and preserves everything else byte-for-byte. It
is a store, not a schema. The wire union in `shared_schema.message_parts` remains
the contract for the *stream*; this is the contract for the *file*, and the two
are deliberately different things.

## Why one directory per Session

`<root>/<session_id>/{session.json,messages.json}`.

R23.5 requires that persisting a Session leaves every pre-existing record
byte-identical, and per-Session files make that true by construction rather than
by careful merging: writing session B cannot touch session A's bytes because it
never opens A's file. It also isolates corruption — one unreadable transcript
costs that Session rather than the list (R23.4) — and it makes delete a
`rmtree` rather than a rewrite of a shared document.

## Why whole-document writes

`replace_messages` is the runtime's path (`onFinish` hands over the *complete*
message list, so an append would duplicate the history), and `append_message` is
the renderer's, for the user turn that must survive a Run that never completes.
Both write the whole file through a temp-then-rename, so a crash mid-write leaves
the previous transcript intact rather than a truncated one. At these sizes — a
500-message Session is a couple of megabytes — a rewrite per turn is cheaper than
the reconciliation an append-only log would need on read.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from shared_schema.models import Session

logger = logging.getLogger(__name__)

#: The four roles a stored message may carry, matching `MessageRole`.
ROLES: Final[frozenset[str]] = frozenset({"user", "assistant", "system", "tool"})

SESSION_FILE: Final = "session.json"
MESSAGES_FILE: Final = "messages.json"


def default_transcript_root() -> Path:
    """``~/.zoc-studio/sessions``, beside the other Desktop_Core-owned state.

    A function rather than a module constant so a test can monkeypatch it, the
    same shape `workspace_binder.default_desktop_config_path` already uses. A
    constant would bake a developer's real home directory into every test run.
    """
    return Path.home() / ".zoc-studio" / "sessions"


class TranscriptRecordError(ValueError):
    """A message that cannot be stored, because its envelope is unusable."""


def _stamp() -> str:
    return datetime.now(UTC).isoformat()


def normalise_record(value: Any) -> dict[str, Any]:
    """Validate the envelope and stamp `createdAt`, preserving everything else.

    Raises `TranscriptRecordError` rather than coercing. A message with no id
    cannot be reconciled on restore and a message with an unknown role cannot be
    rendered, so accepting either would trade a 400 the caller can fix for a
    transcript that silently loses a turn.
    """
    if not isinstance(value, Mapping):
        raise TranscriptRecordError("a transcript message must be an object")
    record: dict[str, Any] = dict(value)

    identifier = record.get("id")
    if not isinstance(identifier, str) or identifier == "":
        raise TranscriptRecordError("a transcript message needs a non-empty string id")

    role = record.get("role")
    if role not in ROLES:
        raise TranscriptRecordError(f"unknown message role: {role!r}")

    parts = record.get("parts")
    if parts is None:
        record["parts"] = []
    elif not isinstance(parts, list):
        raise TranscriptRecordError("a transcript message's parts must be a list")

    # Server-stamped only when absent: a restored record keeps the timestamp it
    # was first written with, or `messages.json` would re-date the whole
    # transcript on every replace and R15.3's last-activity figure would follow.
    if not isinstance(record.get("createdAt"), str):
        record["createdAt"] = _stamp()

    return record


def _readable_record(value: Any) -> dict[str, Any] | None:
    try:
        return normalise_record(value)
    except TranscriptRecordError as exc:
        # Skipped, not raised: one unreadable message must not cost the rest of
        # the transcript, and the transcript is what the user is looking at.
        logger.warning("skipping unreadable transcript message: %s", exc)
        return None


class TranscriptStore:
    """Session metadata plus transcripts, on disk, one directory per Session."""

    def __init__(self, root: Path | str | None = None) -> None:
        self._root = Path(root) if root is not None else default_transcript_root()
        # One lock for the store rather than one per Session: the operations are
        # short file rewrites, the gateway is a single process, and a per-Session
        # lock map is a leak waiting to happen for no measurable gain.
        self._lock = threading.Lock()

    @property
    def root(self) -> Path:
        return self._root

    # ── Layout ────────────────────────────────────────────────────────────

    def _dir(self, session_id: str) -> Path:
        if session_id == "" or "/" in session_id or "\\" in session_id or session_id in {".", ".."}:
            # A session id reaches this from a URL path parameter. It is a UUID in
            # practice, and anything that could climb out of the store's root is
            # refused rather than sanitised.
            raise TranscriptRecordError(f"unusable session id: {session_id!r}")
        return self._root / session_id

    def _write_json(self, path: Path, payload: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(f"{path.suffix}.tmp")
        text = json.dumps(payload, indent=2, sort_keys=False)
        with temp.open("w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # Rename over the target: a crash leaves either the old file or the new
        # one, never a half-written transcript.
        temp.replace(path)

    @staticmethod
    def _read_json(path: Path) -> Any | None:
        try:
            with path.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("unreadable store file %s: %s", path, exc)
            return None

    # ── Session metadata (R15.1–R15.4, R15.11) ────────────────────────────

    def load_sessions(self) -> list[Session]:
        """Every readable Session, newest activity first.

        An unreadable `session.json` is skipped with a log line rather than
        raising: a single corrupt directory would otherwise take the whole list
        with it, and the list is the surface a user needs in order to reach any
        of their other Sessions.
        """
        if not self._root.is_dir():
            return []
        sessions: list[Session] = []
        for entry in sorted(self._root.iterdir()):
            if not entry.is_dir():
                continue
            payload = self._read_json(entry / SESSION_FILE)
            if payload is None:
                continue
            try:
                sessions.append(Session.model_validate(payload))
            except Exception as exc:
                logger.warning("skipping unreadable session %s: %s", entry.name, exc)
        sessions.sort(key=lambda session: session.updated_at, reverse=True)
        return sessions

    def save_session(self, session: Session) -> None:
        """Persist metadata only. The transcript is never touched by this call."""
        with self._lock:
            # `messages` is dropped on the way to disk: R2.4 keeps part data out of
            # the metadata row, and a Session carrying a copy of its own transcript
            # would make `messages.json` the second source of truth for it.
            payload = session.model_copy(update={"messages": []}).model_dump(
                mode="json", by_alias=True
            )
            self._write_json(self._dir(str(session.id)) / SESSION_FILE, payload)

    def delete_session(self, session_id: str) -> bool:
        """Remove the Session and its transcript. `False` when it was not there."""
        with self._lock:
            directory = self._dir(session_id)
            if not directory.is_dir():
                return False
            shutil.rmtree(directory, ignore_errors=True)
            return not directory.exists()

    # ── Transcript (R15.6) ────────────────────────────────────────────────

    def list_messages(self, session_id: str) -> list[dict[str, Any]]:
        """The stored transcript, in stored order, unreadable records skipped."""
        payload = self._read_json(self._dir(session_id) / MESSAGES_FILE)
        if not isinstance(payload, list):
            return []
        readable = (_readable_record(item) for item in payload)
        return [record for record in readable if record is not None]

    def replace_messages(
        self, session_id: str, messages: Sequence[Mapping[str, Any]]
    ) -> list[dict[str, Any]]:
        """Replace the whole transcript — the runtime's `onFinish` path.

        Wholesale rather than incremental because `onFinish` hands over the
        complete conversation: appending it would double every prior turn, and
        diffing it against the file would be reconciliation logic in the process
        that has the least information to reconcile with.
        """
        records = [normalise_record(message) for message in messages]
        with self._lock:
            self._write_json(self._dir(session_id) / MESSAGES_FILE, records)
        return records

    def append_message(self, session_id: str, message: Mapping[str, Any]) -> dict[str, Any]:
        """Add one message, replacing any earlier record with the same id.

        Replace-by-id rather than blind append: the renderer writes the user turn
        on submit and the runtime rewrites the same turn on finish, and two rows
        for one message would render the user's prompt twice.
        """
        record = normalise_record(message)
        with self._lock:
            existing = self.list_messages(session_id)
            kept = [item for item in existing if item.get("id") != record["id"]]
            kept.append(record)
            self._write_json(self._dir(session_id) / MESSAGES_FILE, kept)
        return record

    # ── Search (R15.5) ────────────────────────────────────────────────────

    def message_text(self, session_id: str) -> list[str]:
        """The text a Session search matches against, oldest first.

        Text and reasoning parts only. A search over serialised tool payloads
        would match on JSON keys and paths the user never wrote, which is how a
        recall tool turns into a corpus grep with no explicable results.
        """
        texts: list[str] = []
        for record in self.list_messages(session_id):
            for part in record.get("parts", []):
                if not isinstance(part, Mapping):
                    continue
                if part.get("type") in {"text", "reasoning"}:
                    value = part.get("text")
                    if isinstance(value, str) and value != "":
                        texts.append(value)
        return texts

    def session_ids(self) -> Iterable[str]:
        if not self._root.is_dir():
            return ()
        return tuple(entry.name for entry in sorted(self._root.iterdir()) if entry.is_dir())
