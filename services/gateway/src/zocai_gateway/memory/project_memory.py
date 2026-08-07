"""Persistent per-project agent memory (§14.1).

The three-tier :mod:`~zocai_gateway.memory.matrix` lives *inside* the workspace
(``.zocai/``) and is scoped to a session. This module is the complementary
long-lived store: facts the agent learned about a project, kept **outside** the
workspace so it survives a clean checkout and never shows up in the user's diff.

    ~/.zoc-studio/memory/<workspace_hash>/memory.json

Design decisions worth stating:

* **Hashed directory, not the path.** The directory name is a BLAKE2b digest of
  the resolved workspace path. It keeps the layout flat, avoids illegal
  characters, and does not print the user's directory names into a shared
  location.
* **Atomic writes.** Every save goes through a temporary file and a rename, so a
  crash mid-write leaves the previous memory intact rather than a truncated JSON
  file that would fail to load forever.
* **Semantic de-duplication.** New facts are merged against existing ones by
  token-overlap similarity (see :func:`fact_similarity`), because an LLM
  re-states the same fact in different words on every run and naive equality
  would grow the file without bound.
* **Bounded.** :data:`MAX_FACTS` and :data:`MAX_FILE_SUMMARIES` cap growth; the
  lowest-confidence / oldest entries are dropped first.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path

__all__ = [
    "DEFAULT_SIMILARITY_THRESHOLD",
    "MAX_FACTS",
    "MAX_FILE_SUMMARIES",
    "MEMORY_FILE",
    "FactExtractionPrompt",
    "FileSummary",
    "MemoryFact",
    "ProjectMemory",
    "ProjectMemoryStore",
    "fact_similarity",
    "memory_root",
    "parse_extracted_facts",
    "workspace_hash",
]

logger = logging.getLogger(__name__)

MEMORY_FILE = "memory.json"

#: Facts above this similarity are treated as the same fact (§14.1).
DEFAULT_SIMILARITY_THRESHOLD = 0.72

#: Hard caps so a long-lived project cannot grow memory without bound.
MAX_FACTS = 200
MAX_FILE_SUMMARIES = 500

#: How many facts are injected into the INTAKE prompt (§14.1: "top 10").
TOP_FACTS_FOR_PROMPT = 10

#: The short extraction prompt run after a successful run (§14.1).
FactExtractionPrompt = (
    "Extract factual statements about the codebase from this transcript.\n"
    "Each fact must be a single sentence. Max 5 facts. Be specific."
)

_WORD_RE = re.compile(r"[A-Za-z0-9_]+")

#: Words too common to carry meaning when comparing two facts.
_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "has",
        "have",
        "in",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "uses",
        "use",
        "was",
        "were",
        "which",
        "with",
        "project",
        "code",
        "codebase",
        "file",
        "files",
    }
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def workspace_hash(workspace_root: Path | str) -> str:
    """Stable 16-hex identifier for ``workspace_root``.

    BLAKE2b rather than :func:`hash` so the same workspace maps to the same
    directory across processes and platforms.
    """
    resolved = str(Path(workspace_root).expanduser().resolve())
    return hashlib.blake2b(resolved.encode("utf-8"), digest_size=8).hexdigest()


def memory_root() -> Path:
    """Base directory for all project memory (``~/.zoc-studio/memory``)."""
    home = Path(os.environ.get("ZOC_STUDIO_HOME", Path.home()))
    return home / ".zoc-studio" / "memory"


# ── data model ───────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MemoryFact:
    """One learned fact about the project."""

    fact: str
    source_run_id: str = ""
    confidence: float = 0.5
    created_at: str = field(default_factory=_now)

    def as_dict(self) -> dict[str, object]:
        return {
            "fact": self.fact,
            "source_run_id": self.source_run_id,
            "confidence": self.confidence,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, object]) -> MemoryFact | None:
        text = str(raw.get("fact", "")).strip()
        if not text:
            return None
        raw_confidence = raw.get("confidence", 0.5)
        if isinstance(raw_confidence, bool) or not isinstance(raw_confidence, int | float | str):
            confidence = 0.5
        else:
            try:
                confidence = float(raw_confidence)
            except (TypeError, ValueError):
                confidence = 0.5
        return cls(
            fact=text,
            source_run_id=str(raw.get("source_run_id", "")),
            confidence=min(1.0, max(0.0, confidence)),
            created_at=str(raw.get("created_at") or _now()),
        )


@dataclass(frozen=True, slots=True)
class FileSummary:
    """A one-sentence description of what a file does."""

    summary: str
    last_modified: str = field(default_factory=_now)
    run_id: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "summary": self.summary,
            "last_modified": self.last_modified,
            "run_id": self.run_id,
        }


@dataclass
class ProjectMemory:
    """The persisted document (§14.1 schema)."""

    workspace_hash: str
    last_updated: str = field(default_factory=_now)
    facts: list[MemoryFact] = field(default_factory=list)
    file_summaries: dict[str, FileSummary] = field(default_factory=dict)
    preferences: dict[str, str] = field(default_factory=dict)
    run_count: int = 0
    total_tokens_used: int = 0

    def as_dict(self) -> dict[str, object]:
        return {
            "workspace_hash": self.workspace_hash,
            "last_updated": self.last_updated,
            "facts": [fact.as_dict() for fact in self.facts],
            "file_summaries": {
                path: summary.as_dict() for path, summary in self.file_summaries.items()
            },
            "preferences": dict(self.preferences),
            "run_count": self.run_count,
            "total_tokens_used": self.total_tokens_used,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, object], *, fallback_hash: str) -> ProjectMemory:
        """Rebuild from JSON, tolerating a partially corrupt document.

        Every field is validated independently so one bad entry costs that entry
        rather than the whole memory — losing all learned context because of a
        single malformed record would be a poor trade.
        """
        facts: list[MemoryFact] = []
        raw_facts = raw.get("facts")
        if isinstance(raw_facts, list):
            for entry in raw_facts:
                if isinstance(entry, dict):
                    parsed = MemoryFact.from_dict(entry)
                    if parsed is not None:
                        facts.append(parsed)

        summaries: dict[str, FileSummary] = {}
        raw_summaries = raw.get("file_summaries")
        if isinstance(raw_summaries, dict):
            for path, entry in raw_summaries.items():
                if not isinstance(entry, dict):
                    continue
                text = str(entry.get("summary", "")).strip()
                if not text:
                    continue
                summaries[str(path)] = FileSummary(
                    summary=text,
                    last_modified=str(entry.get("last_modified") or _now()),
                    run_id=str(entry.get("run_id", "")),
                )

        raw_preferences = raw.get("preferences")
        preferences = (
            {str(key): str(value) for key, value in raw_preferences.items()}
            if isinstance(raw_preferences, dict)
            else {}
        )

        def _int(key: str) -> int:
            value = raw.get(key, 0)
            if isinstance(value, bool) or not isinstance(value, int | float | str):
                return 0
            try:
                return max(0, int(value))
            except (TypeError, ValueError):
                return 0

        return cls(
            workspace_hash=str(raw.get("workspace_hash") or fallback_hash),
            last_updated=str(raw.get("last_updated") or _now()),
            facts=facts,
            file_summaries=summaries,
            preferences=preferences,
            run_count=_int("run_count"),
            total_tokens_used=_int("total_tokens_used"),
        )


# ── similarity + parsing ─────────────────────────────────────────────────────


def _significant_tokens(text: str) -> set[str]:
    return {
        token
        for token in (match.group(0).lower() for match in _WORD_RE.finditer(text))
        if token not in _STOPWORDS and len(token) > 2
    }


def fact_similarity(left: str, right: str) -> float:
    """Jaccard similarity of the significant tokens in two facts.

    A deliberately cheap, deterministic stand-in for embedding similarity: the
    de-duplication decision must be reproducible and must not require a model
    call on every save. Identical text scores ``1.0``; disjoint text ``0.0``.
    """
    a = _significant_tokens(left)
    b = _significant_tokens(right)
    if not a or not b:
        return 1.0 if left.strip().lower() == right.strip().lower() else 0.0
    return len(a & b) / len(a | b)


def parse_extracted_facts(raw: str, *, limit: int = 5) -> list[str]:
    """Parse an LLM's fact list into clean sentences (§14.1).

    Accepts the shapes a model actually produces — numbered lists, bullets, or
    bare lines — and drops empty/duplicate entries. Capped at ``limit`` because
    the extraction prompt asks for at most five.
    """
    facts: list[str] = []
    seen: set[str] = set()
    for line in raw.splitlines():
        cleaned = line.strip()
        if not cleaned:
            continue
        cleaned = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", cleaned).strip()
        if len(cleaned) < 8:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        facts.append(cleaned)
        if len(facts) >= limit:
            break
    return facts


# ── store ────────────────────────────────────────────────────────────────────


class ProjectMemoryStore:
    """Load / merge / save the persistent memory for one workspace (§14.1)."""

    def __init__(self, workspace_root: Path | str, *, root: Path | None = None) -> None:
        self.workspace_root = Path(workspace_root).expanduser().resolve()
        self.hash = workspace_hash(self.workspace_root)
        self.directory = (root or memory_root()) / self.hash
        self.path = self.directory / MEMORY_FILE

    # -- persistence -----------------------------------------------------

    def load(self) -> ProjectMemory:
        """Read the stored memory, or an empty one when absent/corrupt."""
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return ProjectMemory(workspace_hash=self.hash)
        except (OSError, json.JSONDecodeError):
            logger.warning("project memory at %s unreadable; starting fresh", self.path)
            return ProjectMemory(workspace_hash=self.hash)
        if not isinstance(raw, dict):
            return ProjectMemory(workspace_hash=self.hash)
        return ProjectMemory.from_dict(raw, fallback_hash=self.hash)

    def save(self, memory: ProjectMemory) -> None:
        """Persist ``memory`` atomically (temp file + rename)."""
        memory.last_updated = _now()
        self.directory.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(memory.as_dict(), indent=2, sort_keys=True)
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=self.directory,
                prefix=".memory-",
                suffix=".tmp",
                delete=False,
            ) as handle:
                handle.write(payload)
                temporary = Path(handle.name)
            temporary.replace(self.path)
        except OSError:
            logger.warning("could not persist project memory to %s", self.path, exc_info=True)

    # -- merging ---------------------------------------------------------

    def merge_facts(
        self,
        memory: ProjectMemory,
        facts: Iterable[str],
        *,
        run_id: str = "",
        confidence: float = 0.6,
        threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    ) -> int:
        """Add ``facts``, skipping ones already known. Returns how many were new.

        A near-duplicate does not merely get dropped: it *raises the confidence*
        of the fact it matches, because independent restatement across runs is
        evidence the fact is real.
        """
        added = 0
        for candidate in facts:
            text = candidate.strip()
            if not text:
                continue
            match_index = next(
                (
                    index
                    for index, existing in enumerate(memory.facts)
                    if fact_similarity(existing.fact, text) >= threshold
                ),
                None,
            )
            if match_index is not None:
                existing = memory.facts[match_index]
                memory.facts[match_index] = replace(
                    existing,
                    confidence=min(1.0, existing.confidence + 0.1),
                )
                continue
            memory.facts.append(MemoryFact(fact=text, source_run_id=run_id, confidence=confidence))
            added += 1

        if len(memory.facts) > MAX_FACTS:
            # Drop the least-supported facts first, then the oldest.
            memory.facts.sort(key=lambda f: (-f.confidence, f.created_at))
            del memory.facts[MAX_FACTS:]
        return added

    def record_file_summary(
        self,
        memory: ProjectMemory,
        path: str,
        summary: str,
        *,
        run_id: str = "",
    ) -> None:
        """Set (or replace) the one-line summary for ``path``."""
        text = summary.strip()
        if not path or not text:
            return
        memory.file_summaries[path] = FileSummary(summary=text, run_id=run_id, last_modified=_now())
        if len(memory.file_summaries) > MAX_FILE_SUMMARIES:
            oldest = sorted(memory.file_summaries.items(), key=lambda item: item[1].last_modified)
            for stale_path, _ in oldest[: len(memory.file_summaries) - MAX_FILE_SUMMARIES]:
                memory.file_summaries.pop(stale_path, None)

    def record_run(self, memory: ProjectMemory, *, tokens_used: int = 0) -> ProjectMemory:
        """Increment the run counters."""
        memory.run_count += 1
        memory.total_tokens_used += max(0, tokens_used)
        return memory


# ── prompt injection ─────────────────────────────────────────────────────────


#: How much query relevance outweighs confidence when ranking facts. §14.1 asks
#: for the "most relevant" facts, so relevance leads and confidence breaks ties
#: — otherwise a highly-confident but unrelated fact would always win a slot.
RELEVANCE_WEIGHT = 2.0


def top_facts(
    memory: ProjectMemory,
    *,
    limit: int = TOP_FACTS_FOR_PROMPT,
    query: str | None = None,
) -> list[MemoryFact]:
    """The most relevant facts for a prompt (§14.1).

    With a ``query``, facts sharing vocabulary with it rank first (weighted by
    :data:`RELEVANCE_WEIGHT`), with confidence as the secondary signal; without
    one, ranking falls back to confidence then recency.
    """

    def score(fact: MemoryFact) -> tuple[float, str]:
        relevance = fact_similarity(fact.fact, query) if query else 0.0
        return (-(relevance * RELEVANCE_WEIGHT + fact.confidence), fact.created_at)

    return sorted(memory.facts, key=score)[: max(0, limit)]


def render_memory_prompt(facts: Sequence[MemoryFact]) -> str:
    """The INTAKE prompt section, or ``""`` when there is nothing to say."""
    if not facts:
        return ""
    lines = "\n".join(f"- {fact.fact}" for fact in facts)
    return f"Known facts about this project:\n{lines}"
