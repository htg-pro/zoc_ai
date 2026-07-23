"""The ``RAG_Matcher`` (Layer 3, R8.1 + R1.7 + R1.8).

The matcher scans local workspace folders and open editor buffers, scoring
every candidate code fragment on a ``0.0``–``1.0`` relevance scale against the
task query. It returns only the fragments whose score is **greater than or
equal to ``0.7``**, capped at a maximum of **50** fragments (R8.1).

The scored fragments are then shaped per the selected model tier:

* **Local SLM** — inject *only* the fragments that reference the active target
  file, so a 2k–4k window is not flooded with unrelated context (R1.7).
* **Cloud** — inject a full multi-file source map, a dependency map, and the
  compiled steering directives into a single prompt window (R1.8).
* **Edge** — inject the matched multi-file fragments as-is (the in-between tier
  is unconstrained by R1.7/R1.8).

:class:`RagMatcher` is the abstract contract the Ask/Agent context builders
depend on (only ``extract`` is required); :class:`NullRagMatcher` is the no-op
default. :class:`WorkspaceRagMatcher` is the real implementation that performs
the scan and tier-aware shaping.

The high-frequency relevance scan is the second Rust-accelerated hot path in
the design. The scan is kept behind an injectable ``scan_hook`` so a PyO3-bound
Rust scanner can be dropped in without changing callers; when no hook is bound
a pure-Python scorer is used, which is acceptable until the Rust path is wired
up.
"""

from __future__ import annotations

import math
import os
import re
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Protocol, TypeVar, runtime_checkable

from zocai_gateway.model_interface import ModelTier

__all__ = [
    "MAX_FRAGMENTS",
    "RELEVANCE_THRESHOLD",
    "BM25Index",
    "FragmentSource",
    "InjectedContext",
    "NullRagMatcher",
    "OpenBuffer",
    "QueryEmbedder",
    "RagFragment",
    "RagMatcher",
    "ScanHook",
    "Scorer",
    "WorkspaceRagMatcher",
    "cosine_sim",
    "default_scorer",
    "hybrid_rank",
    "hybrid_search",
    "rrf",
]

# Minimum relevance for a fragment to be retained, on a 0.0-1.0 scale (R8.1).
RELEVANCE_THRESHOLD = 0.7

# Maximum number of fragments the matcher ever returns (R8.1).
MAX_FRAGMENTS = 50

# Tokens used both for scoring and for the lightweight dependency scan.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")

# Import/dependency reference patterns for the Cloud dependency map (R1.8).
_DEP_RE = re.compile(
    r"""^\s*(?:
        from\s+(?P<from>[\w./-]+)\s+import\b   # python: from x import y
        | import\s+(?P<import>[\w./-]+)         # python/js: import x
        | (?:const|let|var)\s+\w+\s*=\s*require\(['"](?P<require>[^'"]+)['"]\)
        | (?:import|export)\b[^'"]*['"](?P<es>[^'"]+)['"]  # es-module specifier
    )""",
    re.VERBOSE,
)


class FragmentSource(str, Enum):
    """Where a candidate fragment was scanned from."""

    FOLDER = "folder"  # a file on disk under a scanned workspace folder
    BUFFER = "buffer"  # an open editor buffer (possibly unsaved)


@dataclass(frozen=True, slots=True)
class RagFragment:
    """A single relevant code fragment returned by the RAG_Matcher.

    :attr:`path` locates the source; :attr:`content` is the extracted text
    injected into the context payload; :attr:`score` is the relevance on a
    ``0.0``–``1.0`` scale (the matcher returns only fragments scoring ≥ 0.7,
    R8.1). :attr:`source` records whether the fragment came from a scanned
    folder file or an open editor buffer.
    """

    path: str
    content: str
    score: float
    source: FragmentSource = FragmentSource.FOLDER


@dataclass(frozen=True, slots=True)
class OpenBuffer:
    """An open editor buffer supplied to the scan.

    Buffers may hold unsaved content, so their text is scanned directly rather
    than re-read from disk.
    """

    path: str
    content: str


@dataclass(frozen=True, slots=True)
class InjectedContext:
    """The tier-shaped context payload produced by :meth:`WorkspaceRagMatcher.inject`.

    :attr:`fragments` are the fragments actually injected for the tier (for
    Local SLM these are only the active-target fragments, R1.7).
    :attr:`source_maps`, :attr:`dependency_maps`, and :attr:`steering` are
    populated only for the Cloud tier (R1.8) and are otherwise empty.
    """

    tier: ModelTier
    fragments: tuple[RagFragment, ...] = ()
    source_maps: Mapping[str, str] = field(default_factory=dict)
    dependency_maps: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    steering: str = ""


# A scan hook scores a batch of ``(path, content)`` candidates against the
# query, returning one score per candidate in order. This is the seam the
# Rust-accelerated scanner binds to; the pure-Python path uses ``Scorer``.
ScanHook = Callable[[str, Sequence[tuple[str, str]]], Sequence[float]]

# A scorer computes the relevance of a single ``(query, content)`` pair.
Scorer = Callable[[str, str], float]

# A query embedder returns one vector for the supplied query text.
QueryEmbedder = Callable[[str], Sequence[float]]
ChunkT = TypeVar("ChunkT")


@runtime_checkable
class RagMatcher(Protocol):
    """Contract the Ask/Agent context builders depend on (R8.1, R2.6).

    Implementations scan local folders and open editor buffers for fragments
    relevant to ``query`` and return them already filtered and capped. Callers
    that only need raw fragments use ``extract``; tier-aware shaping and the
    Rust-accelerated scan are internal to the concrete implementation.
    """

    def extract(self, query: str) -> tuple[RagFragment, ...]:
        """Return the relevant fragments for ``query`` (possibly empty)."""
        ...


class NullRagMatcher:
    """A RAG_Matcher stub that always returns no fragments (R2.6 placeholder).

    Used where a matcher is required but no scan is wired, so the Ask path can
    run RAG extraction unconditionally. Satisfies the :class:`RagMatcher`
    protocol.
    """

    def extract(self, query: str) -> tuple[RagFragment, ...]:
        return ()


def _tokenize(text: str) -> list[str]:
    """Lowercased alphanumeric word tokens of ``text``."""
    return [match.group(0).lower() for match in _TOKEN_RE.finditer(text)]


def default_scorer(query: str, content: str) -> float:
    """Pure-Python relevance score in ``[0.0, 1.0]``.

    The score is the fraction of distinct query tokens that also appear in the
    fragment content (query-term coverage). An empty query or empty content
    scores ``0.0``. This is deterministic and order-independent, which keeps
    the scan stable when the Rust hot path is not bound.
    """
    query_tokens = set(_tokenize(query))
    if not query_tokens:
        return 0.0
    content_tokens = set(_tokenize(content))
    if not content_tokens:
        return 0.0
    overlap = len(query_tokens & content_tokens)
    return overlap / len(query_tokens)


class BM25Index:
    """Small dependency-free BM25 index over an ordered document collection."""

    def __init__(
        self,
        documents: Sequence[str],
        *,
        k1: float = 1.5,
        b: float = 0.75,
    ) -> None:
        if k1 <= 0:
            raise ValueError("k1 must be greater than zero")
        if not 0 <= b <= 1:
            raise ValueError("b must be between zero and one")

        tokenized = [tuple(_tokenize(document)) for document in documents]
        self._term_frequencies = tuple(Counter(tokens) for tokens in tokenized)
        self._document_lengths = tuple(len(tokens) for tokens in tokenized)
        self._document_count = len(tokenized)
        self._average_document_length = (
            sum(self._document_lengths) / self._document_count
            if self._document_count
            else 0.0
        )
        document_frequencies: Counter[str] = Counter()
        for tokens in tokenized:
            document_frequencies.update(set(tokens))
        self._document_frequencies = document_frequencies
        self._k1 = k1
        self._b = b

    @property
    def document_count(self) -> int:
        return self._document_count

    def get_scores(self, query_tokens: Sequence[str]) -> list[float]:
        """Return one BM25 score per indexed document in insertion order."""
        if not self._document_count:
            return []
        terms = tuple(dict.fromkeys(token.lower() for token in query_tokens if token))
        if not terms:
            return [0.0] * self._document_count

        scores = [0.0] * self._document_count
        average_length = self._average_document_length or 1.0
        for term in terms:
            frequency = self._document_frequencies.get(term, 0)
            if frequency == 0:
                continue
            inverse_document_frequency = math.log(
                1.0
                + (self._document_count - frequency + 0.5) / (frequency + 0.5)
            )
            for index, term_frequencies in enumerate(self._term_frequencies):
                term_frequency = term_frequencies.get(term, 0)
                if term_frequency == 0:
                    continue
                length_ratio = self._document_lengths[index] / average_length
                denominator = term_frequency + self._k1 * (
                    1.0 - self._b + self._b * length_ratio
                )
                scores[index] += inverse_document_frequency * (
                    term_frequency * (self._k1 + 1.0) / denominator
                )
        return scores


def cosine_sim(
    query_embedding: Sequence[float],
    embeddings: Sequence[Sequence[float]],
) -> list[float]:
    """Return cosine similarity between one query vector and each row."""
    query = tuple(float(value) for value in query_embedding)
    if any(not math.isfinite(value) for value in query):
        raise ValueError("query embedding contains a non-finite value")
    query_norm = math.sqrt(sum(value * value for value in query))

    scores: list[float] = []
    for embedding in embeddings:
        row = tuple(float(value) for value in embedding)
        if len(row) != len(query):
            raise ValueError(
                f"embedding dimension {len(row)} does not match query dimension {len(query)}"
            )
        if any(not math.isfinite(value) for value in row):
            raise ValueError("embedding contains a non-finite value")
        row_norm = math.sqrt(sum(value * value for value in row))
        if query_norm == 0.0 or row_norm == 0.0:
            scores.append(0.0)
            continue
        similarity = sum(left * right for left, right in zip(query, row, strict=True))
        scores.append(max(-1.0, min(1.0, similarity / (query_norm * row_norm))))
    return scores


def rrf(*score_sets: Sequence[float], k: int = 60) -> list[float]:
    """Fuse ranked score lists using reciprocal rank fusion.

    Only positive, finite scores participate. This prevents zero-score
    documents from entering the result merely because they have an array
    position. Equal scores are resolved by document index for deterministic
    output.
    """
    if k < 0:
        raise ValueError("k must be non-negative")
    if not score_sets:
        return []
    document_count = len(score_sets[0])
    if any(len(scores) != document_count for scores in score_sets):
        raise ValueError("all score sets must have the same length")

    combined = [0.0] * document_count
    for scores in score_sets:
        ranked = sorted(
            (
                (index, float(score))
                for index, score in enumerate(scores)
                if math.isfinite(float(score)) and float(score) > 0.0
            ),
            key=lambda item: (-item[1], item[0]),
        )
        for rank, (index, _score) in enumerate(ranked, start=1):
            combined[index] += 1.0 / (k + rank)
    return combined


def hybrid_rank(
    query: str,
    *,
    bm25_index: BM25Index,
    embeddings: Sequence[Sequence[float]],
    embed_query: QueryEmbedder,
    limit: int = 20,
    rrf_k: int = 60,
) -> list[tuple[int, float]]:
    """Rank indexed documents by fused BM25 and semantic retrieval order."""
    if limit <= 0 or bm25_index.document_count == 0:
        return []
    if len(embeddings) != bm25_index.document_count:
        raise ValueError("embedding count must match the BM25 document count")

    bm25_scores = bm25_index.get_scores(_tokenize(query))
    semantic_scores = cosine_sim(embed_query(query), embeddings)
    combined = rrf(bm25_scores, semantic_scores, k=rrf_k)
    ranked = sorted(
        ((index, score) for index, score in enumerate(combined) if score > 0.0),
        key=lambda item: (-item[1], item[0]),
    )
    return ranked[:limit]


def hybrid_search(
    query: str,
    chunks: Sequence[ChunkT],
    *,
    bm25_index: BM25Index,
    embeddings: Sequence[Sequence[float]],
    embed_query: QueryEmbedder,
    k: int = 20,
    rrf_k: int = 60,
) -> list[ChunkT]:
    """Return the top chunks from BM25 and semantic reciprocal-rank fusion."""
    if len(chunks) != bm25_index.document_count:
        raise ValueError("chunk count must match the BM25 document count")
    ranked = hybrid_rank(
        query,
        bm25_index=bm25_index,
        embeddings=embeddings,
        embed_query=embed_query,
        limit=k,
        rrf_k=rrf_k,
    )
    return [chunks[index] for index, _score in ranked]


class WorkspaceRagMatcher:
    """Scans for relevant fragments and shapes them per model tier.

    The relevance scan is exposed behind :paramref:`scan_hook` so a
    Rust-accelerated scanner can replace the default pure-Python scorer
    without changing callers. The matcher satisfies the :class:`RagMatcher`
    protocol via :meth:`extract`, which scans the configured folders and open
    buffers.
    """

    def __init__(
        self,
        *,
        folders: Sequence[Path] = (),
        open_buffers: Sequence[OpenBuffer] = (),
        scan_hook: ScanHook | None = None,
        scorer: Scorer = default_scorer,
        threshold: float = RELEVANCE_THRESHOLD,
        max_fragments: int = MAX_FRAGMENTS,
    ) -> None:
        """Create a matcher.

        :param folders: Default workspace folders scanned by :meth:`extract`.
        :param open_buffers: Default open editor buffers scanned by
            :meth:`extract`.
        :param scan_hook: Optional batch scorer (the Rust hot-loop seam). When
            provided it scores all candidates at once; otherwise ``scorer`` is
            applied per candidate.
        :param scorer: Per-fragment scorer used when no ``scan_hook`` is bound.
        :param threshold: Minimum retained relevance (defaults to ``0.7``).
        :param max_fragments: Hard cap on returned fragments (defaults to 50).
        """
        self._folders = tuple(folders)
        self._open_buffers = tuple(open_buffers)
        self._scan_hook = scan_hook
        self._scorer = scorer
        self._threshold = threshold
        self._max_fragments = max_fragments

    # -- protocol entrypoint ---------------------------------------------

    def extract(self, query: str) -> tuple[RagFragment, ...]:
        """Scan the configured folders/buffers for ``query`` (R8.1)."""
        return self.scan(
            query, folders=self._folders, open_buffers=self._open_buffers
        )

    # -- scanning ---------------------------------------------------------

    def scan(
        self,
        query: str,
        *,
        folders: Iterable[Path] = (),
        open_buffers: Iterable[OpenBuffer] = (),
    ) -> tuple[RagFragment, ...]:
        """Scan ``folders`` and ``open_buffers`` for relevant fragments.

        Returns the fragments whose relevance score is ``>= threshold``,
        ordered by descending score (ties broken by path for determinism) and
        capped at ``max_fragments`` (R8.1). Unreadable or non-text files are
        skipped so a single bad file never aborts the scan.
        """
        candidates = self._collect_candidates(folders, open_buffers)
        if not candidates:
            return ()

        scores = self._score(query, [(c.path, c.content) for c in candidates])

        scored: list[RagFragment] = []
        for candidate, raw_score in zip(candidates, scores, strict=True):
            score = _clamp_unit(raw_score)
            if score >= self._threshold:
                scored.append(
                    RagFragment(
                        path=candidate.path,
                        content=candidate.content,
                        score=score,
                        source=candidate.source,
                    )
                )

        # Highest relevance first; stable, deterministic tie-break by path.
        scored.sort(key=lambda fragment: (-fragment.score, fragment.path))
        return tuple(scored[: self._max_fragments])

    def _score(
        self, query: str, candidates: Sequence[tuple[str, str]]
    ) -> Sequence[float]:
        """Score ``candidates`` via the Rust hook if bound, else the scorer."""
        if self._scan_hook is not None:
            scores = self._scan_hook(query, candidates)
            if len(scores) != len(candidates):
                raise ValueError(
                    "scan_hook returned "
                    f"{len(scores)} scores for {len(candidates)} candidates"
                )
            return scores
        return [self._scorer(query, content) for _path, content in candidates]

    def _collect_candidates(
        self,
        folders: Iterable[Path],
        open_buffers: Iterable[OpenBuffer],
    ) -> list[RagFragment]:
        """Gather unscored candidate fragments from folders and buffers.

        Open buffers take precedence over their on-disk counterparts (a buffer
        may hold unsaved edits), so a path present in ``open_buffers`` is not
        re-read from disk.
        """
        candidates: list[RagFragment] = []
        buffer_paths: set[str] = set()

        for buffer in open_buffers:
            buffer_paths.add(buffer.path)
            candidates.append(
                RagFragment(
                    path=buffer.path,
                    content=buffer.content,
                    score=0.0,
                    source=FragmentSource.BUFFER,
                )
            )

        for folder in folders:
            for file_path in _iter_text_files(folder):
                path_str = str(file_path)
                if path_str in buffer_paths:
                    continue
                content = _read_text(file_path)
                if content is None:
                    continue
                candidates.append(
                    RagFragment(
                        path=path_str,
                        content=content,
                        score=0.0,
                        source=FragmentSource.FOLDER,
                    )
                )

        return candidates

    # -- tier-aware injection --------------------------------------------

    def inject(
        self,
        tier: ModelTier,
        fragments: Sequence[RagFragment],
        *,
        active_target: str | None = None,
        steering: str = "",
    ) -> InjectedContext:
        """Shape ``fragments`` into a tier-appropriate context payload.

        * Local SLM: only fragments referencing ``active_target`` (R1.7).
        * Cloud: full multi-file source map, dependency map, and steering
          directives (R1.8).
        * Edge: the matched multi-file fragments unchanged.
        """
        if tier is ModelTier.LOCAL_SLM:
            target = (
                tuple(f for f in fragments if f.path == active_target)
                if active_target is not None
                else ()
            )
            return InjectedContext(tier=tier, fragments=target)

        if tier is ModelTier.CLOUD:
            return InjectedContext(
                tier=tier,
                fragments=tuple(fragments),
                source_maps=_build_source_maps(fragments),
                dependency_maps=_build_dependency_maps(fragments),
                steering=steering,
            )

        # Edge (and any future middle tier): inject matched fragments as-is.
        return InjectedContext(tier=tier, fragments=tuple(fragments))

    def enrich(
        self,
        query: str,
        tier: ModelTier,
        *,
        folders: Iterable[Path] = (),
        open_buffers: Iterable[OpenBuffer] = (),
        active_target: str | None = None,
        steering: str = "",
    ) -> InjectedContext:
        """Scan then inject in one call: the matcher's public entry point."""
        fragments = self.scan(query, folders=folders, open_buffers=open_buffers)
        return self.inject(
            tier, fragments, active_target=active_target, steering=steering
        )


def _clamp_unit(value: float) -> float:
    """Clamp ``value`` into the ``[0.0, 1.0]`` relevance scale."""
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


def _build_source_maps(fragments: Sequence[RagFragment]) -> dict[str, str]:
    """Group fragment content by path into a multi-file source map (R1.8)."""
    source_maps: dict[str, str] = {}
    for fragment in fragments:
        if fragment.path in source_maps:
            source_maps[fragment.path] += "\n\n" + fragment.content
        else:
            source_maps[fragment.path] = fragment.content
    return source_maps


def _build_dependency_maps(
    fragments: Sequence[RagFragment],
) -> dict[str, tuple[str, ...]]:
    """Map each fragment path to the modules it references (R1.8).

    A lightweight line scan extracts ``import``/``from``/``require``/ES-module
    specifiers. References are de-duplicated while preserving first-seen order.
    """
    dependency_maps: dict[str, tuple[str, ...]] = {}
    for fragment in fragments:
        seen: dict[str, None] = {}
        for line in fragment.content.splitlines():
            match = _DEP_RE.match(line)
            if match is None:
                continue
            ref = (
                match.group("from")
                or match.group("import")
                or match.group("require")
                or match.group("es")
            )
            if ref:
                seen.setdefault(ref, None)
        existing = dependency_maps.get(fragment.path, ())
        merged = list(existing)
        for ref in seen:
            if ref not in merged:
                merged.append(ref)
        dependency_maps[fragment.path] = tuple(merged)
    return dependency_maps


#: Directory names never descended into during a workspace scan. These are
#: build outputs, VCS metadata, and dependency caches that would make a
#: per-run scan pathologically slow (and never carry useful task context).
#: Kept in sync with ``run_pipeline._ISOLATED_IGNORE_NAMES``.
_SCAN_IGNORE_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".venv",
        "venv",
        ".idea",
        ".vscode",
    }
)

#: Skip files larger than this (bytes); source files are far smaller, and huge
#: files are almost always generated/minified/binary and only bloat the scan.
_MAX_SCAN_FILE_BYTES = 512 * 1024


def _iter_text_files(folder: Path) -> Iterable[Path]:
    """Yield regular files under ``folder`` (recursively).

    Prunes heavy build/VCS/cache directories (:data:`_SCAN_IGNORE_DIRS`) in
    place so the scan never descends into ``node_modules`` / ``.git`` / etc.,
    skips oversized (likely generated/binary) files, and skips directories that
    cannot be traversed — so the scan stays fast and operational over large,
    partially-readable trees.
    """
    for dirpath, dirnames, filenames in os.walk(folder, onerror=lambda _e: None):
        # Prune ignored directories in place so os.walk does not descend them.
        dirnames[:] = [
            name for name in dirnames if name not in _SCAN_IGNORE_DIRS
        ]
        base = Path(dirpath)
        for name in sorted(filenames):
            entry = base / name
            try:
                stat = entry.stat()
            except OSError:
                continue
            if stat.st_size > _MAX_SCAN_FILE_BYTES:
                continue
            yield entry


def _read_text(path: Path) -> str | None:
    """Read ``path`` as UTF-8 text, or ``None`` if it is unreadable/binary."""
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError, ValueError):
        return None
