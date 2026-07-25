"""The one structured error envelope the Gateway puts on the wire.

Every failure the renderer can see is serialised to the same shape::

    {"code": str, "message": str, "details": str | None, "retryable": bool}

Why this exists. Before this module the gateway raised bare
``HTTPException(detail="unknown run: <uuid>")`` and the renderer rendered
``detail`` verbatim, so a normal cancellation race produced the user-facing
string ``Error: unknown run: 9f3c…`` — an internal identifier presented as if it
were a diagnosis. Worse, a thrown non-``Error`` value on the client side
stringified to ``Error: undefined``.

Two rules follow from that and are enforced here:

1. **``message`` is for humans.** It names what happened and what to do about
   it. It never contains a run id, a filesystem path, an API key, a stack
   trace, or a Python type name.
2. **``details`` is for developers.** It is optional, and callers only populate
   it with information that is already safe to show (never secrets). Full
   diagnostics stay in the structured server log, keyed by the same ``code``.

``retryable`` tells the UI whether offering a "Retry" affordance makes sense.
"""

from __future__ import annotations

from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "ERROR_MESSAGES",
    "ErrorCode",
    "ErrorEnvelope",
    "error_body",
    "error_envelope",
    "sanitize_detail",
]


class ErrorCode:
    """Stable machine-readable error codes.

    Plain string constants rather than an ``Enum`` so they serialise as-is and
    can be compared against values parsed from JSON without a lookup.
    """

    NO_WORKSPACE: Final = "no_workspace"
    WORKSPACE_INVALID: Final = "workspace_invalid"
    PATH_OUTSIDE_WORKSPACE: Final = "path_outside_workspace"
    RUN_NOT_FOUND: Final = "run_not_found"
    RUN_ALREADY_FINISHED: Final = "run_already_finished"
    RUN_ATTACH_FAILED: Final = "run_attach_failed"
    RUN_LIMIT_REACHED: Final = "run_limit_reached"
    RUN_TIMEOUT: Final = "run_timeout"
    RUN_FAILED: Final = "run_failed"
    RUN_CANCELLED: Final = "run_cancelled"
    MODEL_PROCESS_EXITED: Final = "model_process_exited"
    MODE_NOT_PERMITTED: Final = "mode_not_permitted"
    INVALID_REQUEST: Final = "invalid_request"
    TERMINAL_NOT_FOUND: Final = "terminal_not_found"
    TERMINAL_SPAWN_FAILED: Final = "terminal_spawn_failed"
    TERMINAL_CWD_INVALID: Final = "terminal_cwd_invalid"
    INTERNAL: Final = "internal_error"


#: Default user-readable message per code. Callers may override with a more
#: specific (still path/id-free) sentence, but never with raw exception text.
ERROR_MESSAGES: Final[dict[str, str]] = {
    ErrorCode.NO_WORKSPACE: (
        "No workspace is open. Open a project folder before using Agent mode."
    ),
    ErrorCode.WORKSPACE_INVALID: (
        "The selected workspace folder is missing or is not a directory. Open the folder again."
    ),
    ErrorCode.PATH_OUTSIDE_WORKSPACE: (
        "That path is outside the open workspace, so the action was blocked."
    ),
    ErrorCode.RUN_NOT_FOUND: ("The agent run ended before it could be attached. Please retry."),
    ErrorCode.RUN_ALREADY_FINISHED: "That run has already finished.",
    ErrorCode.RUN_ATTACH_FAILED: ("The agent run ended before it could be attached. Please retry."),
    ErrorCode.RUN_LIMIT_REACHED: (
        "Too many runs are already active. Stop one before starting another."
    ),
    ErrorCode.RUN_TIMEOUT: "The run took too long and was stopped.",
    ErrorCode.RUN_FAILED: "The run stopped because of an error. See logs for details.",
    ErrorCode.RUN_CANCELLED: "Stopped.",
    ErrorCode.MODEL_PROCESS_EXITED: (
        "The model process stopped unexpectedly. See logs for details."
    ),
    ErrorCode.MODE_NOT_PERMITTED: ("That action is not available in the current chat mode."),
    ErrorCode.INVALID_REQUEST: "The request was incomplete or malformed.",
    ErrorCode.TERMINAL_NOT_FOUND: "That terminal session is no longer running.",
    ErrorCode.TERMINAL_SPAWN_FAILED: "The terminal could not be started.",
    ErrorCode.TERMINAL_CWD_INVALID: (
        "The terminal working directory is not inside the open workspace."
    ),
    ErrorCode.INTERNAL: "Something went wrong. See logs for details.",
}

#: Codes worth offering a retry for: the failure is transient or racy rather
#: than a rejected request.
_RETRYABLE: Final[frozenset[str]] = frozenset(
    {
        ErrorCode.RUN_ATTACH_FAILED,
        ErrorCode.RUN_LIMIT_REACHED,
        ErrorCode.RUN_TIMEOUT,
        ErrorCode.MODEL_PROCESS_EXITED,
        ErrorCode.INTERNAL,
    }
)

#: Hard cap on ``details`` so a runaway payload cannot be used to flood the UI.
_MAX_DETAIL_CHARS: Final = 600


class ErrorEnvelope(BaseModel):
    """The single serialised error shape (Phase 2C)."""

    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    details: str | None = None
    retryable: bool = Field(default=False)


def sanitize_detail(detail: object | None) -> str | None:
    """Bound and normalise a developer-facing ``details`` string.

    Only trims and truncates: deciding *what* is safe to include is the
    caller's job, because only the caller knows whether a given string came
    from a user-authored prompt or from a credential.
    """
    if detail is None:
        return None
    text = str(detail).strip()
    if not text:
        return None
    if len(text) > _MAX_DETAIL_CHARS:
        return text[:_MAX_DETAIL_CHARS] + "…"
    return text


def error_envelope(
    code: str,
    *,
    message: str | None = None,
    details: object | None = None,
    retryable: bool | None = None,
) -> ErrorEnvelope:
    """Build an :class:`ErrorEnvelope` for ``code``.

    ``message`` defaults to the registered user-readable sentence for ``code``,
    so a caller cannot accidentally put raw exception text in front of a user by
    forgetting to supply one.
    """
    resolved_message = message or ERROR_MESSAGES.get(code, ERROR_MESSAGES[ErrorCode.INTERNAL])
    resolved_retryable = code in _RETRYABLE if retryable is None else retryable
    return ErrorEnvelope(
        code=code,
        message=resolved_message,
        details=sanitize_detail(details),
        retryable=resolved_retryable,
    )


def error_body(
    code: str,
    *,
    message: str | None = None,
    details: object | None = None,
    retryable: bool | None = None,
) -> dict[str, Any]:
    """An ``HTTPException(detail=…)`` payload carrying the envelope.

    FastAPI serialises ``HTTPException.detail`` as-is, so passing this dict
    makes the response body ``{"detail": {"code": …, "message": …}}``. Existing
    clients that read ``detail`` as a string still get something meaningful
    because the renderer's normaliser (``lib/errors.ts``) understands both the
    legacy string form and this structured form.
    """
    return error_envelope(
        code,
        message=message,
        details=details,
        retryable=retryable,
    ).model_dump()
