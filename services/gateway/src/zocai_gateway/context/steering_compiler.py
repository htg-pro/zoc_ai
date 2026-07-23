"""The ``Steering_Compiler`` (Layer 3, R8.2 + R8.7).

The compiler reads steering rule files matching the path pattern
``.zoc/steering/*.md`` and compiles them into a context payload **in lexical
order of file path** (R8.2). If any matched file cannot be read or fails to
parse, that file is skipped, excluded from the payload, and compilation
continues over the remaining files (R8.7).

The steering directory is injectable (``steering_dir``) so the compiler can be
driven against a temporary tree in tests without touching the real workspace.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from zocai_gateway.context.token_gate import CHARS_PER_TOKEN, estimate_tokens
from zocai_gateway.model_interface import ModelInterface, ModelRequest
from zocai_gateway.toolsets import ReadOnlyViolation

if TYPE_CHECKING:
    from zocai_gateway.mode_router import AgentRunRequest

__all__ = [
    "DEFAULT_STEERING_DIR",
    # -- MAP_FILES stage logic (§ "Implement MAP_FILES stage logic") ---------
    "MAP_FILES_INSTRUCTION",
    "MAX_READ_FILES",
    "PER_FILE_TOKEN_CAP",
    "STEERING_GLOB",
    "TRUNCATION_MARKER",
    "FileSelector",
    "MapFilesEmitter",
    "MapFilesError",
    "MapFilesEvent",
    "SteeringFragment",
    "SteeringPayload",
    "build_read_files_payload",
    "compile_steering",
    "is_write_preapproved",
    "model_file_selector",
    "preapproved_writes",
    "runtime_file_selector",
    "select_map_files",
]

# Relative location of steering rule files, per R8.2. The glob is applied
# inside the (injectable) steering directory, so only the file-name pattern
# is needed here.
STEERING_GLOB = "*.md"

# Default steering directory relative to the workspace root: ``.zoc/steering``.
DEFAULT_STEERING_DIR = Path(".zoc") / "steering"


@dataclass(frozen=True, slots=True)
class SteeringFragment:
    """One successfully compiled steering rule file.

    :attr:`path` is the file path as a string (used as the lexical sort key);
    :attr:`content` is the parsed text included in the context payload.
    """

    path: str
    content: str


@dataclass(frozen=True, slots=True)
class SteeringPayload:
    """The compiled steering context payload.

    :attr:`fragments` are the included files in lexical path order (R8.2).
    :attr:`skipped` lists the paths of files excluded because they could not
    be read or failed to parse (R8.7), also in lexical path order.
    """

    fragments: tuple[SteeringFragment, ...] = ()
    skipped: tuple[str, ...] = field(default=())

    @property
    def text(self) -> str:
        """The concatenated steering text, in lexical path order."""
        return "\n\n".join(fragment.content for fragment in self.fragments)


def _default_parse(raw: str) -> str:
    """Default steering parser.

    Steering files are free-form Markdown, so parsing is the identity over the
    decoded text. A custom ``parse`` callable may raise to signal an
    unparseable file (R8.7); see :func:`compile_steering`.
    """
    return raw


def compile_steering(
    steering_dir: Path = DEFAULT_STEERING_DIR,
    *,
    parse: Callable[[str], str] = _default_parse,
) -> SteeringPayload:
    """Compile ``.zoc/steering/*.md`` into a :class:`SteeringPayload`.

    Files are compiled in lexical order of their path (R8.2). Any file that
    cannot be read (``OSError``, e.g. permission denied or a directory) or
    that cannot be decoded/parsed (``UnicodeDecodeError`` / ``ValueError``
    raised by ``parse``) is skipped, excluded from the payload, and recorded
    in :attr:`SteeringPayload.skipped` while compilation continues (R8.7).

    :param steering_dir: Directory searched for ``*.md`` steering files.
        Injectable for testability; defaults to ``.zoc/steering``.
    :param parse: Optional parser applied to each file's decoded text. Raising
        ``ValueError`` (or ``UnicodeDecodeError``) marks a file unparseable.
    """
    try:
        matches = list(steering_dir.glob(STEERING_GLOB))
    except OSError:
        # The steering directory itself is missing or unreadable: no steering
        # context is available, but the run stays operational (R8.7).
        return SteeringPayload()

    # Lexical order of file path (R8.2). Sorting by the string form gives a
    # deterministic, total order over the matched paths.
    ordered = sorted(matches, key=lambda path: str(path))

    fragments: list[SteeringFragment] = []
    skipped: list[str] = []

    for path in ordered:
        path_str = str(path)
        try:
            raw = path.read_text(encoding="utf-8")
            content = parse(raw)
        except (OSError, UnicodeDecodeError, ValueError):
            # Unreadable or unparseable: skip, exclude, and keep going (R8.7).
            skipped.append(path_str)
            continue
        fragments.append(SteeringFragment(path=path_str, content=content))

    return SteeringPayload(fragments=tuple(fragments), skipped=tuple(skipped))


# ===========================================================================
# MAP_FILES stage logic
# ===========================================================================
#
# The MAP_FILES stage turns the task description plus the ``hybrid_search``
# candidate files into a concrete, minimal plan of which files the run will
# *read* and which it will *write* (create or modify). A senior-engineer LLM
# prompt does the selection; the returned paths are validated to stay inside
# the workspace root; and a :class:`MapFilesEvent` is emitted so the UI can show
# a "Files this run will touch" card.
#
# The two downstream stages consume the result:
#   * READ_FILES   — :func:`build_read_files_payload` reads each ``read_list``
#                    file and frames it as ``=== FILE: {path} ===`` with a hard
#                    per-file cap of :data:`PER_FILE_TOKEN_CAP` tokens.
#   * APPLY_EDITS  — ``write_list`` is the pre-approved write allowlist, so no
#                    extra approval prompt fires for those paths
#                    (:func:`is_write_preapproved`).

# The verbatim instruction handed to the selecting model.
MAP_FILES_INSTRUCTION = (
    "You are a senior engineer. Given the task and these candidate files, "
    "select the MINIMUM set of files to read (max 8). For each file explain "
    "why it is needed. Also list files you will CREATE or MODIFY even if you "
    "haven't read them yet.\n"
    "Output JSON: { read: [path], write: [path], rationale: str }"
)

# Hard ceiling on how many files the stage will read (matches the prompt's
# "max 8"). The read list is truncated to this many entries after validation.
MAX_READ_FILES = 8

# Hard per-file token cap applied when injecting file content in READ_FILES.
PER_FILE_TOKEN_CAP = 2000

# Appended in place of the elided tail when a file is truncated to the cap.
TRUNCATION_MARKER = "... [truncated]"


class MapFilesError(RuntimeError):
    """Raised when the model's file-selection output cannot be parsed."""


@dataclass(frozen=True, slots=True)
class MapFilesEvent:
    """The MAP_FILES result, surfaced to the UI as a "Files this run will touch" card.

    :attr:`read_list` are the workspace-relative files the run will read
    (already validated and capped to :data:`MAX_READ_FILES`); :attr:`write_list`
    are the files it will create or modify (the pre-approved write allowlist);
    :attr:`rationale` is the model's short explanation of the selection.
    """

    read_list: tuple[str, ...]
    write_list: tuple[str, ...]
    rationale: str


# Turns the fully-rendered selection prompt into the model's raw JSON response.
# Injectable so the stage is testable without a live model.
FileSelector = Callable[[str], str]

# Sink for the MAP_FILES card event (e.g. an event-bus publish adapter).
MapFilesEmitter = Callable[[MapFilesEvent], None]


def model_file_selector(
    model: ModelInterface,
    *,
    context_window: int | None = None,
    max_tokens: int = 800,
) -> FileSelector:
    """Adapt a :class:`ModelInterface` into a :data:`FileSelector`.

    The returned callable runs the selection prompt through ``model.generate``
    at temperature 0 (deterministic) and returns the response text, which
    :func:`select_map_files` then parses as JSON.
    """

    def _select(prompt: str) -> str:
        request = ModelRequest(
            prompt=prompt,
            context_window=context_window or model.context_window,
            max_tokens=max_tokens,
            temperature=0.0,
        )
        return model.generate(request).text

    return _select


def runtime_file_selector(request: AgentRunRequest) -> FileSelector:
    """Adapt the configured runtime provider into the MAP_FILES selector."""

    def _select(prompt: str) -> str:
        # Local import avoids ``model_runtime -> mode_router -> steering`` cycles.
        from zocai_gateway.model_runtime import generate_text

        text = generate_text(
            request.model_copy(update={"prompt": prompt}),
            timeout=120.0,
        )
        if not text or not text.strip():
            raise MapFilesError("file-selection produced no response")
        return text

    return _select


def _candidate_path(candidate: object) -> str:
    """Extract a path string from a ``hybrid_search`` candidate.

    Accepts either a plain path string or any object exposing a ``path``
    attribute (e.g. a :class:`~zocai_gateway.context.rag_matcher.RagFragment`),
    so the stage works directly on whatever the matcher returned.
    """
    path = getattr(candidate, "path", None)
    if path is None:
        chunk = getattr(candidate, "chunk", None)
        path = getattr(chunk, "file", candidate)
    return str(path)


def _render_candidates(candidates: Sequence[object]) -> str:
    """Render candidate files as a deterministic, de-duplicated bullet list."""
    seen: set[str] = set()
    lines: list[str] = []
    for candidate in candidates:
        path = _candidate_path(candidate)
        if path in seen:
            continue
        seen.add(path)
        lines.append(f"- {path}")
    return "\n".join(lines)


def _extract_json_object(raw: str) -> dict[str, object]:
    """Parse the model's response into a JSON object, tolerating code fences.

    Strips an optional ```/```json fence, then falls back to the substring
    between the first ``{`` and last ``}`` so a model that wraps the JSON in
    prose still parses. Raises :class:`MapFilesError` if no object is found.
    """
    text = raw.strip()
    if text.startswith("```"):
        # Drop the opening fence line (``` or ```json) and any closing fence.
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end < start:
            raise MapFilesError("file-selection output is not valid JSON") from None
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise MapFilesError("file-selection output is not valid JSON") from exc

    if not isinstance(parsed, dict):
        raise MapFilesError("file-selection output must be a JSON object")
    return parsed


def _string_list(value: object) -> list[str]:
    """Coerce a JSON field into a list of non-empty path strings."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def _validate_within_workspace(path_str: str, workspace_root: Path) -> str | None:
    """Return ``path_str`` normalized workspace-relative, or ``None`` if it escapes.

    A path that resolves outside ``workspace_root`` (absolute elsewhere, or via
    ``..``) is rejected. Non-existent paths are allowed because ``write_list``
    files may not exist yet (they are about to be created).
    """
    try:
        candidate = (workspace_root / Path(path_str)).resolve()
        relative = candidate.relative_to(workspace_root)
    except (ValueError, OSError):
        return None
    normalized = relative.as_posix()
    # The workspace root itself is not a file the run can read or write.
    if normalized in ("", "."):
        return None
    return normalized


def _validated_paths(paths: Sequence[str], workspace_root: Path) -> tuple[str, ...]:
    """Validate, normalize, and de-duplicate ``paths`` against the workspace (step 3)."""
    seen: set[str] = set()
    kept: list[str] = []
    for path in paths:
        normalized = _validate_within_workspace(path, workspace_root)
        if normalized is None or normalized in seen:
            continue
        seen.add(normalized)
        kept.append(normalized)
    return tuple(kept)


def select_map_files(
    task: str,
    candidates: Sequence[object],
    *,
    select: FileSelector,
    workspace_root: Path | str = ".",
    emit: MapFilesEmitter | None = None,
) -> MapFilesEvent:
    """Run the MAP_FILES stage: choose the files to read and write.

    Steps (matching the stage spec):

    1. Receive the ``task`` description and the ``hybrid_search`` ``candidates``.
    2. Prompt the model (via ``select``) with :data:`MAP_FILES_INSTRUCTION` to
       pick the minimum read set (max 8) plus the create/modify write set.
    3. Validate every returned path stays within ``workspace_root``; paths that
       escape are dropped, and the read list is capped to
       :data:`MAX_READ_FILES`.
    4. Emit a :class:`MapFilesEvent` (``read_list``, ``write_list``,
       ``rationale``) so the UI can show the "Files this run will touch" card.

    :raises MapFilesError: if the model output cannot be parsed as a JSON object.
    """
    root = Path(workspace_root).resolve()

    prompt = (
        f"{MAP_FILES_INSTRUCTION}\n\n"
        f"Task:\n{task}\n\n"
        f"Candidate files:\n{_render_candidates(candidates)}"
    )
    raw = select(prompt)
    parsed = _extract_json_object(raw)

    read_list = _validated_paths(_string_list(parsed.get("read")), root)[:MAX_READ_FILES]
    write_list = _validated_paths(_string_list(parsed.get("write")), root)
    rationale_value = parsed.get("rationale", "")
    rationale = rationale_value.strip() if isinstance(rationale_value, str) else ""

    event = MapFilesEvent(
        read_list=read_list,
        write_list=write_list,
        rationale=rationale,
    )
    if emit is not None:
        emit(event)
    return event


def _truncate_to_token_cap(content: str, token_cap: int) -> str:
    """Cap ``content`` at ``token_cap`` tokens, marking a mid-file truncation.

    Uses the deterministic char-per-token estimate shared with the token gate.
    When the content fits it is returned unchanged; otherwise it is cut to the
    cap's character budget and :data:`TRUNCATION_MARKER` is appended.
    """
    if token_cap <= 0:
        return TRUNCATION_MARKER
    if estimate_tokens(content) <= token_cap:
        return content
    suffix = f"\n{TRUNCATION_MARKER}"
    max_chars = max(0, token_cap * CHARS_PER_TOKEN - len(suffix))
    if max_chars == 0 and estimate_tokens(suffix) > token_cap:
        return TRUNCATION_MARKER
    return f"{content[:max_chars]}{suffix}"


def build_read_files_payload(
    read_list: Sequence[str],
    read_file: Callable[[str], str],
    *,
    token_cap: int = PER_FILE_TOKEN_CAP,
) -> str:
    """Run the READ_FILES stage: inject each read file's content into context.

    Calls ``read_file`` (e.g. ``Toolset.read_file``) on each path in
    ``read_list`` and frames the content as ``=== FILE: {path} ===\\n{content}\\n``.
    Each file is hard-capped at ``token_cap`` tokens; a larger file is truncated
    mid-file with :data:`TRUNCATION_MARKER`. A file that cannot be read is
    skipped so one bad path does not abort the stage.
    """
    blocks: list[str] = []
    for path in read_list:
        try:
            content = read_file(path)
        except (OSError, ReadOnlyViolation, UnicodeError):
            # Unreadable or unconfined file: skip it and keep injecting the rest.
            continue
        capped = _truncate_to_token_cap(content, token_cap)
        blocks.append(f"=== FILE: {path} ===\n{capped}\n")
    return "".join(blocks)


def preapproved_writes(event: MapFilesEvent) -> frozenset[str]:
    """The APPLY_EDITS pre-approved write allowlist from a MAP_FILES result.

    Membership is keyed on the normalized workspace-relative paths in
    :attr:`MapFilesEvent.write_list`; see :func:`is_write_preapproved`.
    """
    return frozenset(event.write_list)


def is_write_preapproved(
    path: Path | str,
    allowlist: frozenset[str],
    *,
    workspace_root: Path | str = ".",
) -> bool:
    """Whether writing ``path`` is pre-approved by the MAP_FILES write allowlist.

    Normalizes ``path`` the same way MAP_FILES normalized the allowlist (so an
    absolute or differently-spelled but equivalent path still matches) and
    returns ``True`` when it is a member. APPLY_EDITS uses this to skip the
    approval prompt for files the run already declared it would touch.
    """
    normalized = _validate_within_workspace(str(path), Path(workspace_root).resolve())
    return normalized is not None and normalized in allowlist
