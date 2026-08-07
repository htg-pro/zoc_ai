"""Security audit log and input validation (§15.1).

Two responsibilities:

* **Audit trail.** :func:`log_security_event` appends a JSONL record to
  ``~/.zoc-studio/security.log`` for every prompt-injection detection, blocked
  path traversal, and permission denial. Append-only JSONL is deliberate: it is
  cheap to write from any thread, survives a crash mid-write (a truncated final
  line is the only damage), and is trivially greppable.

* **Input validation.** :func:`validate_user_text` and :class:`RateLimiter`
  enforce the §15.1 limits on anything a user (or a compromised renderer) can
  push into the gateway.

Nothing here ever raises into a run: an audit failure must not be able to break
the operation it was auditing.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic

__all__ = [
    "MAX_USER_TEXT_LENGTH",
    "RATE_LIMIT_PER_MINUTE",
    "SECURITY_LOG_FILE",
    "RateLimitDecision",
    "RateLimiter",
    "SecurityEventKind",
    "ValidationResult",
    "log_security_event",
    "security_log_path",
    "strip_control_characters",
    "validate_user_text",
]

logger = logging.getLogger(__name__)

SECURITY_LOG_FILE = "security.log"

#: Reject user-supplied text longer than this (§15.1).
MAX_USER_TEXT_LENGTH = 10_000

#: Maximum run starts per minute per workspace (§15.1).
RATE_LIMIT_PER_MINUTE = 10

#: Audited event kinds (§15.1).
SecurityEventKind = str  # "prompt_injection" | "path_traversal" | "permission_denied"

#: Control characters that carry no meaning in source text. Tab, newline and
#: carriage return are preserved because they are legitimate in code.
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

_log_lock = threading.Lock()


def security_log_path() -> Path:
    """Path of the audit log (``~/.zoc-studio/security.log``)."""
    home = Path(os.environ.get("ZOC_STUDIO_HOME", Path.home()))
    return home / ".zoc-studio" / SECURITY_LOG_FILE


def log_security_event(
    kind: SecurityEventKind,
    detail: str,
    **fields: object,
) -> None:
    """Append one audit record. Never raises (§15.1).

    Serialised under a lock so concurrent runs cannot interleave partial lines
    into the same file.
    """
    record = {
        "ts": datetime.now(UTC).isoformat(),
        "kind": kind,
        "detail": detail,
        **{key: value for key, value in fields.items() if value is not None},
    }
    try:
        path = security_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, default=str)
        with _log_lock, path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception:  # pragma: no cover - auditing must never break a run
        logger.debug("could not append security event %r", kind, exc_info=True)


# ── input validation ─────────────────────────────────────────────────────────


def strip_control_characters(text: str) -> str:
    """Remove null bytes and non-printable control characters (§15.1).

    Tabs and newlines survive: stripping them would corrupt every code snippet
    the user pastes, and they are not the injection vector this guards against.
    """
    return _CONTROL_RE.sub("", text.replace("\x00", ""))


@dataclass(frozen=True, slots=True)
class ValidationResult:
    """Outcome of validating user-supplied text."""

    ok: bool
    text: str = ""
    reason: str = ""


def validate_user_text(
    text: object,
    *,
    max_length: int = MAX_USER_TEXT_LENGTH,
    field: str = "text",
) -> ValidationResult:
    """Validate and clean a user-supplied string (§15.1).

    Rejects non-strings and over-length input; strips control characters from
    everything that passes. Length is checked **after** stripping so padding a
    payload with null bytes cannot be used to smuggle content past the limit.
    """
    if not isinstance(text, str):
        return ValidationResult(ok=False, reason=f"{field} must be a string")
    cleaned = strip_control_characters(text)
    if len(cleaned) > max_length:
        return ValidationResult(
            ok=False,
            reason=f"{field} exceeds {max_length} characters ({len(cleaned)})",
        )
    return ValidationResult(ok=True, text=cleaned)


# ── rate limiting ────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class RateLimitDecision:
    """Whether an action is allowed, and when to retry if not."""

    allowed: bool
    remaining: int = 0
    retry_after_seconds: float = 0.0


class RateLimiter:
    """Sliding-window limiter keyed by workspace (§15.1).

    A sliding window rather than a fixed bucket: a fixed window lets a caller
    fire ``2 * limit`` runs across a boundary, which defeats the point of the
    limit. Timestamps older than the window are discarded on each check, so
    memory stays proportional to the limit rather than to uptime.
    """

    def __init__(
        self,
        *,
        limit: int = RATE_LIMIT_PER_MINUTE,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if limit <= 0:
            raise ValueError("limit must be positive")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = {}

    @property
    def limit(self) -> int:
        return self._limit

    def check(self, key: str) -> RateLimitDecision:
        """Record an attempt for ``key`` and report whether it is allowed."""
        now = float(self._clock())
        with self._lock:
            window = self._hits.setdefault(key, deque())
            cutoff = now - self._window
            while window and window[0] <= cutoff:
                window.popleft()
            if len(window) >= self._limit:
                retry_after = max(0.0, window[0] + self._window - now)
                return RateLimitDecision(
                    allowed=False, remaining=0, retry_after_seconds=retry_after
                )
            window.append(now)
            return RateLimitDecision(allowed=True, remaining=self._limit - len(window))

    def reset(self, key: str | None = None) -> None:
        """Forget recorded attempts (all keys when ``key`` is ``None``)."""
        with self._lock:
            if key is None:
                self._hits.clear()
            else:
                self._hits.pop(key, None)
