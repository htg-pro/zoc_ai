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

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

__all__ = [
    "STEERING_GLOB",
    "DEFAULT_STEERING_DIR",
    "SteeringFragment",
    "SteeringPayload",
    "compile_steering",
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
