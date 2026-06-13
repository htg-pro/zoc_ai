"""Centralised tool-execution sandbox.

Every tool's ``execute`` runs through :class:`Sandbox` so the agent gets a
single chokepoint for:

* Per-call timeouts (so a model-driven tool can't stall a run forever).
* Output caps (so a runaway ``read_file`` or ``search`` can't dump 200 MiB
  back into the LLM context).
* Path containment (single resolver shared by all filesystem tools instead
  of three near-copies).
* Argv-based command-risk classification (used by ``run_command`` instead
  of fragile string-prefix matching).

Tools opt into different limits by overriding the class attribute
``sandbox_limits`` (see :class:`SandboxLimits`); the defaults are tuned for
an interactive coding agent.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any

from shared_schema.models import ToolResult

if TYPE_CHECKING:  # pragma: no cover
    from .base import Tool, ToolContext


_log = logging.getLogger(__name__)


# ── limits ────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class SandboxLimits:
    """Resource limits for a single tool invocation.

    ``timeout_s = None`` disables the outer timeout (used by tools that
    enforce their own — see :class:`RunCommandTool`).
    """

    timeout_s: float | None = 30.0
    max_output_bytes: int = 1_000_000  # 1 MiB

    def with_(self, **kwargs: Any) -> SandboxLimits:
        return replace(self, **kwargs)


# Per-tool defaults. Tools pick one of these by setting
# ``sandbox_limits = SandboxLimits.READ`` etc; the bare class default
# (above) is the conservative "general" limit.
SandboxLimits.READ = SandboxLimits(timeout_s=5.0, max_output_bytes=1_000_000)  # type: ignore[attr-defined]
SandboxLimits.WRITE = SandboxLimits(timeout_s=10.0, max_output_bytes=256_000)  # type: ignore[attr-defined]
SandboxLimits.LIST = SandboxLimits(timeout_s=5.0, max_output_bytes=256_000)  # type: ignore[attr-defined]
SandboxLimits.SEARCH = SandboxLimits(timeout_s=30.0, max_output_bytes=1_000_000)  # type: ignore[attr-defined]
SandboxLimits.AST = SandboxLimits(timeout_s=30.0, max_output_bytes=256_000)  # type: ignore[attr-defined]
SandboxLimits.INDEX_QUERY = SandboxLimits(timeout_s=30.0, max_output_bytes=256_000)  # type: ignore[attr-defined]
SandboxLimits.PATCH = SandboxLimits(timeout_s=30.0, max_output_bytes=256_000)  # type: ignore[attr-defined]
# run_command bounds itself; the Sandbox just budgets a wide ceiling for
# the surrounding scaffolding (path resolve, hotpath handshake) and leaves
# the user-supplied timeout_ms to do the actual work.
SandboxLimits.RUN_COMMAND = SandboxLimits(timeout_s=None, max_output_bytes=8_000_000)  # type: ignore[attr-defined]


DEFAULT_LIMITS = SandboxLimits()


# ── path containment ──────────────────────────────────────────────────────


def resolve_path(workspace_root: str | Path, raw: str) -> Path:
    """Resolve ``raw`` against ``workspace_root`` and reject any escape.

    Raises :class:`ToolExecutionError` (deferred import to avoid cycles) on
    a path that resolves outside the workspace. Used by every filesystem
    tool so the containment rule is implemented once.
    """

    from .base import ToolExecutionError

    root = Path(workspace_root).resolve()
    raw_p = Path(raw)
    candidate = (raw_p if raw_p.is_absolute() else root / raw_p).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ToolExecutionError(f"path escapes workspace: {raw}") from exc
    return candidate


# ── command-risk classification ───────────────────────────────────────────


class CommandRisk(str, Enum):
    safe = "safe"
    destructive = "destructive"


# argv[0] basenames that are destructive on their own. Used by
# ``run_command`` (and any future spawn-a-process tool) instead of the
# legacy "starts with 'rm '" string match.
_DESTRUCTIVE_BASENAMES: frozenset[str] = frozenset(
    {
        "rm",
        "rmdir",
        "sudo",
        "doas",
        "shutdown",
        "reboot",
        "halt",
        "poweroff",
        "dd",
    }
)

_RECURSIVE_FLAGS: frozenset[str] = frozenset({"-r", "-R", "--recursive", "-rf", "-fr", "-Rf", "-fR"})

_SHELL_INTERPRETERS: frozenset[str] = frozenset({"sh", "bash", "zsh", "dash", "ksh", "fish"})

# Substrings that, when seen inside a shell `-c` payload, indicate the
# user is about to do something destructive even though argv[0] is just
# `/bin/sh`. Cheap heuristic — not a security boundary.
_SHELL_DESTRUCTIVE_TOKENS: tuple[str, ...] = (
    "rm -rf",
    "rm -fr",
    ":(){",  # classic fork bomb
    "mkfs",
    "dd of=",
    " > /dev/sd",
    "shutdown",
    "reboot",
)


def classify_command(cmd: str, argv: list[str]) -> CommandRisk:
    """Return :class:`CommandRisk` for ``cmd argv``.

    argv-based, not string-prefix-based: ``/usr/bin/rm`` and ``rm`` and
    ``./rm`` all classify the same way, and ``rmdir`` no longer hides
    behind a missing trailing space.
    """

    name = Path(cmd).name.lower()
    if name in _DESTRUCTIVE_BASENAMES:
        return CommandRisk.destructive
    if name.startswith("mkfs"):
        return CommandRisk.destructive
    if name == "chmod" and any(a in _RECURSIVE_FLAGS for a in argv):
        return CommandRisk.destructive
    if name == "chown" and any(a in _RECURSIVE_FLAGS for a in argv):
        return CommandRisk.destructive
    if name in _SHELL_INTERPRETERS:
        # Inspect a `-c "<payload>"` invocation. We don't try to be clever
        # — anything matching a known dangerous substring is escalated.
        for i, arg in enumerate(argv):
            if arg == "-c" and i + 1 < len(argv):
                payload = argv[i + 1].lower()
                if any(tok in payload for tok in _SHELL_DESTRUCTIVE_TOKENS):
                    return CommandRisk.destructive
    return CommandRisk.safe


# ── output truncation ─────────────────────────────────────────────────────


def truncate_data(data: Any, max_bytes: int) -> tuple[Any, bool, int]:
    """If ``data`` JSON-serialises to more than ``max_bytes``, replace it
    with a structured truncation envelope.

    Returns ``(data_or_envelope, truncated, original_bytes)``. The model
    consumes the envelope as a normal tool result, so a ``read_file`` of a
    huge log surfaces as ``{"truncated": true, "original_bytes": …,
    "preview": "…"}`` instead of pushing megabytes back into the LLM
    context. We keep the *first* ``max_bytes`` of the JSON so the model
    still sees the head of the result (typical for a search/log).
    """

    serialised = json.dumps(data, default=str)
    raw = serialised.encode("utf-8")
    if len(raw) <= max_bytes:
        return data, False, len(raw)
    preview = raw[:max_bytes].decode("utf-8", errors="ignore")
    envelope = {
        "truncated": True,
        "original_bytes": len(raw),
        "max_output_bytes": max_bytes,
        "preview": preview,
    }
    return envelope, True, len(raw)


# ── execute wrapper ───────────────────────────────────────────────────────


class Sandbox:
    """Single chokepoint for tool execution.

    Public API is :meth:`execute`; the rest of the module exposes the
    helpers (:func:`resolve_path`, :func:`classify_command`,
    :func:`truncate_data`) that tools call directly when they need just a
    piece of the policy.
    """

    @staticmethod
    async def execute(
        tool: Tool[Any, Any],
        ctx: ToolContext,
        raw_args: dict[str, Any],
    ) -> ToolResult:
        from .base import ToolExecutionError

        limits: SandboxLimits = getattr(tool, "sandbox_limits", DEFAULT_LIMITS)
        try:
            tool._check_permissions(ctx)
            args = tool.Input.model_validate(raw_args)
        except ToolExecutionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=f"{type(exc).__name__}: {exc}")

        try:
            if limits.timeout_s is None:
                data = await tool.run(ctx, args)
            else:
                data = await asyncio.wait_for(tool.run(ctx, args), timeout=limits.timeout_s)
        except TimeoutError:
            _log.warning(
                "sandbox: tool %s timed out after %ss", tool.name, limits.timeout_s
            )
            return ToolResult(
                ok=False, error=f"timeout after {limits.timeout_s:g}s"
            )
        except ToolExecutionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=f"{type(exc).__name__}: {exc}")

        capped, truncated, original_bytes = truncate_data(
            data, limits.max_output_bytes
        )
        if truncated:
            _log.info(
                "sandbox: tool %s output truncated %d → %d bytes",
                tool.name,
                original_bytes,
                limits.max_output_bytes,
            )
        return ToolResult(ok=True, data=capped)
