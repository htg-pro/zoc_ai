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

import hashlib
import logging
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
    "SHARD_COUNT",
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
    "ShardFragmentLoader",
    "ShardStats",
    "ShardedFragmentIndex",
    "WorkspaceRagMatcher",
    "cosine_sim",
    "default_scorer",
    "hybrid_rank",
    "hybrid_search",
    "rrf",
    "shard_for_path",
]

# Minimum relevance for a fragment to be retained, on a 0.0-1.0 scale (R8.1).
RELEVANCE_THRESHOLD = 0.7

# Maximum number of fragments the matcher ever returns (R8.1).
MAX_FRAGMENTS = 50

# Number of shards the fragment/embedding index is split into (§9.1). Files are
# assigned by ``hash(path) mod SHARD_COUNT``, so a search that can narrow its
# candidate set to a handful of paths only materialises the shards those paths
# live in instead of the whole index.
SHARD_COUNT = 64

logger = logging.getLogger(__name__)

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


# ── Sharded, lazily-loaded fragment index (§9.1) ─────────────────────────────

#: Materialises the fragments for the paths belonging to a single shard. This is
#: the seam the on-disk / embedding-backed store binds to; the workspace matcher
#: supplies a reader that loads file text from disk.
ShardFragmentLoader = Callable[[Sequence[str]], Sequence["RagFragment"]]


def shard_for_path(path: str, shard_count: int = SHARD_COUNT) -> int:
    """Return the shard id owning ``path`` (§9.1).

    Uses BLAKE2b rather than :func:`hash` because ``hash`` of a ``str`` is
    salted per process (``PYTHONHASHSEED``): a salted assignment would move
    files between shards on every restart, invalidating any persisted shard and
    making the mapping untestable. BLAKE2b keeps the assignment stable across
    processes and platforms while spreading paths evenly.
    """
    if shard_count <= 0:
        raise ValueError("shard_count must be positive")
    digest = hashlib.blake2b(path.encode("utf-8", "surrogatepass"), digest_size=8)
    return int.from_bytes(digest.digest(), "big") % shard_count


@dataclass(frozen=True, slots=True)
class ShardStats:
    """Occupancy snapshot of a :class:`ShardedFragmentIndex`.

    :attr:`resident_shards` is the number of shards currently materialised in
    memory — the figure that makes the ~64x reduction observable: a search
    narrowed to one shard leaves ``resident_shards == 1`` instead of 64.
    """

    shard_count: int
    registered_paths: int
    populated_shards: int
    resident_shards: int
    resident_fragments: int
    shard_loads: int


class ShardedFragmentIndex:
    """A fragment index split into ``shard_count`` independently loaded shards.

    Membership (which path lives in which shard) is cheap and always resident:
    it is derived from the path itself via :func:`shard_for_path`, so
    registering 100k paths costs only the path strings. Fragment *content* is
    the expensive part, and it is loaded per shard, on demand, by the injected
    :data:`ShardFragmentLoader`.

    :meth:`search` is the point of the design: given candidate paths it loads
    only the shards those paths hash into. With 64 shards, a query narrowed to
    a few files touches one or two shards, so resident memory is roughly
    ``1/64`` of the full index (§9.1).

    ``max_resident_shards`` bounds how many shards stay materialised; the
    least-recently-used shard is evicted past that point, so long-lived
    processes cannot accumulate the whole index one narrow query at a time.
    """

    def __init__(
        self,
        *,
        loader: ShardFragmentLoader,
        shard_count: int = SHARD_COUNT,
        max_resident_shards: int | None = None,
    ) -> None:
        if shard_count <= 0:
            raise ValueError("shard_count must be positive")
        if max_resident_shards is not None and max_resident_shards <= 0:
            raise ValueError("max_resident_shards must be positive when set")
        self._loader = loader
        self._shard_count = shard_count
        self._max_resident_shards = max_resident_shards
        self._membership: dict[int, dict[str, None]] = {}
        self._resident: dict[int, tuple[RagFragment, ...]] = {}
        self._recency: list[int] = []
        self._shard_loads = 0

    @property
    def shard_count(self) -> int:
        return self._shard_count

    def register(self, paths: Iterable[str]) -> None:
        """Record ``paths`` as index members without loading their content.

        This is the lazy-index entry point: enumeration is O(paths) in memory
        and performs no reads, so a 100k-file monorepo can be "indexed" at
        startup and only pay for content when a shard is actually searched.
        """
        for path in paths:
            bucket = self._membership.setdefault(
                shard_for_path(path, self._shard_count), {}
            )
            bucket.setdefault(path, None)

    def paths_in_shard(self, shard_id: int) -> tuple[str, ...]:
        """Registered paths belonging to ``shard_id`` (sorted, deterministic)."""
        return tuple(sorted(self._membership.get(shard_id, {})))

    def shard_ids_for(self, paths: Iterable[str]) -> tuple[int, ...]:
        """Sorted shard ids that ``paths`` hash into."""
        return tuple(sorted({shard_for_path(p, self._shard_count) for p in paths}))

    def is_resident(self, shard_id: int) -> bool:
        return shard_id in self._resident

    def load_shard(self, shard_id: int) -> tuple[RagFragment, ...]:
        """Materialise ``shard_id``, reusing an already-resident copy.

        A loader failure yields an empty shard rather than raising: one
        unreadable file must not make retrieval fail for the whole workspace.
        """
        resident = self._resident.get(shard_id)
        if resident is not None:
            self._touch(shard_id)
            return resident

        paths = self.paths_in_shard(shard_id)
        if not paths:
            return ()
        try:
            fragments = tuple(self._loader(paths))
        except Exception:  # pragma: no cover - defensive loader boundary
            logger.warning("shard %d failed to load", shard_id, exc_info=True)
            fragments = ()
        self._shard_loads += 1
        self._resident[shard_id] = fragments
        self._touch(shard_id)
        self._enforce_residency_cap()
        return fragments

    def fragments_for_paths(self, paths: Iterable[str]) -> tuple[RagFragment, ...]:
        """Fragments for ``paths``, loading only the shards they live in."""
        wanted = {str(p) for p in paths}
        if not wanted:
            return ()
        out: list[RagFragment] = []
        for shard_id in self.shard_ids_for(wanted):
            out.extend(f for f in self.load_shard(shard_id) if f.path in wanted)
        out.sort(key=lambda fragment: fragment.path)
        return tuple(out)

    def search(
        self,
        query: str,
        *,
        candidate_paths: Iterable[str] | None = None,
        scorer: Scorer = default_scorer,
        threshold: float = RELEVANCE_THRESHOLD,
        max_fragments: int = MAX_FRAGMENTS,
    ) -> tuple[RagFragment, ...]:
        """Score the candidate shards' fragments against ``query`` (§9.1).

        ``candidate_paths`` is the narrowing signal: only the shards those paths
        hash into are loaded. Passing ``None`` searches every populated shard,
        which is the correct-but-expensive fallback used when nothing narrows
        the query.
        """
        if candidate_paths is None:
            shard_ids = tuple(sorted(self._membership))
            wanted: set[str] | None = None
        else:
            wanted = {str(p) for p in candidate_paths}
            if not wanted:
                return ()
            shard_ids = self.shard_ids_for(wanted)

        scored: list[RagFragment] = []
        for shard_id in shard_ids:
            for fragment in self.load_shard(shard_id):
                if wanted is not None and fragment.path not in wanted:
                    continue
                score = _clamp_unit(scorer(query, fragment.content))
                if score >= threshold:
                    scored.append(
                        RagFragment(
                            path=fragment.path,
                            content=fragment.content,
                            score=score,
                            source=fragment.source,
                        )
                    )
        scored.sort(key=lambda fragment: (-fragment.score, fragment.path))
        return tuple(scored[:max_fragments])

    def evict(self, shard_id: int) -> None:
        self._resident.pop(shard_id, None)
        if shard_id in self._recency:
            self._recency.remove(shard_id)

    def evict_all(self) -> None:
        self._resident.clear()
        self._recency.clear()

    def stats(self) -> ShardStats:
        return ShardStats(
            shard_count=self._shard_count,
            registered_paths=sum(len(bucket) for bucket in self._membership.values()),
            populated_shards=len(self._membership),
            resident_shards=len(self._resident),
            resident_fragments=sum(len(f) for f in self._resident.values()),
            shard_loads=self._shard_loads,
        )

    def _touch(self, shard_id: int) -> None:
        if shard_id in self._recency:
            self._recency.remove(shard_id)
        self._recency.append(shard_id)

    def _enforce_residency_cap(self) -> None:
        cap = self._max_resident_shards
        if cap is None:
            return
        while len(self._resident) > cap and self._recency:
            self.evict(self._recency[0])


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
        lazy: bool = False,
        shard_count: int = SHARD_COUNT,
        max_resident_shards: int | None = 8,
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
        :param lazy: When true, :meth:`extract` performs no eager read pass.
            Paths are enumerated once into a :class:`ShardedFragmentIndex` and
            file content is read only for the shards a query actually needs
            (§9.1, the ``--lazy-index`` posture).
        :param shard_count: Number of shards used in lazy mode.
        :param max_resident_shards: How many shards may stay materialised in
            lazy mode before the least-recently-used one is evicted.
        """
        self._folders = tuple(folders)
        self._open_buffers = tuple(open_buffers)
        self._scan_hook = scan_hook
        self._scorer = scorer
        self._threshold = threshold
        self._max_fragments = max_fragments
        self.lazy = lazy
        self._shard_count = shard_count
        self._shard_index: ShardedFragmentIndex | None = (
            ShardedFragmentIndex(
                loader=self._load_shard_fragments,
                shard_count=shard_count,
                max_resident_shards=max_resident_shards,
            )
            if lazy
            else None
        )
        self._shards_registered = False

    # -- protocol entrypoint ---------------------------------------------

    def extract(self, query: str) -> tuple[RagFragment, ...]:
        """Scan the configured folders/buffers for ``query`` (R8.1).

        In lazy mode this routes through the sharded index so only the shards
        holding candidate paths are read (§9.1); otherwise it performs the
        original eager scan.
        """
        if self._shard_index is not None:
            return self._extract_sharded(query)
        return self.scan(
            query, folders=self._folders, open_buffers=self._open_buffers
        )

    # -- lazy / sharded retrieval (§9.1) ----------------------------------

    @property
    def shard_index(self) -> ShardedFragmentIndex | None:
        """The sharded index backing lazy mode, or ``None`` when eager."""
        return self._shard_index

    def register_paths(self, paths: Iterable[str]) -> None:
        """Add ``paths`` to the lazy shard index without reading them.

        Used when the agent touches a file the initial enumeration missed (a
        freshly created file), so it becomes retrievable on the next query.
        No-op when the matcher is eager.
        """
        if self._shard_index is not None:
            self._shard_index.register(paths)

    def _extract_sharded(self, query: str) -> tuple[RagFragment, ...]:
        index = self._shard_index
        assert index is not None  # guarded by the caller
        self._ensure_shards_registered()

        candidates = self._narrow_candidates(query, index)
        fragments = index.search(
            query,
            candidate_paths=candidates,
            scorer=self._scorer,
            threshold=self._threshold,
            max_fragments=self._max_fragments,
        )
        # Open buffers are always in play: they may hold unsaved edits that no
        # shard on disk reflects, and they are cheap (already in memory).
        buffer_hits = self._score_buffers(query)
        merged = list(fragments) + [
            f for f in buffer_hits if all(f.path != kept.path for kept in fragments)
        ]
        merged.sort(key=lambda fragment: (-fragment.score, fragment.path))
        return tuple(merged[: self._max_fragments])

    def _ensure_shards_registered(self) -> None:
        """Enumerate workspace paths into shards once, without reading them."""
        index = self._shard_index
        if index is None or self._shards_registered:
            return
        for folder in self._folders:
            index.register(str(p) for p in _iter_text_files(folder))
        self._shards_registered = True

    def _narrow_candidates(
        self, query: str, index: ShardedFragmentIndex
    ) -> tuple[str, ...] | None:
        """Pick the candidate paths whose shards are worth loading.

        The narrowing signal is path-name overlap with the query's tokens
        (``"fix the rag matcher"`` → paths containing ``rag`` or ``matcher``).
        When nothing matches we return ``None``, which makes the search fall
        back to every populated shard — correct, just not cheap. This keeps
        recall identical to the eager scan while making the common, specific
        query touch one or two shards.
        """
        tokens = {t for t in _tokenize(query) if len(t) >= 3}
        if not tokens:
            return None
        matches = [
            path
            for shard_id in range(index.shard_count)
            for path in index.paths_in_shard(shard_id)
            if tokens & set(_tokenize(path))
        ]
        return tuple(matches) if matches else None

    def _load_shard_fragments(self, paths: Sequence[str]) -> list[RagFragment]:
        """Read one shard's files into unscored fragments (the shard loader)."""
        loaded: list[RagFragment] = []
        for path in paths:
            content = _read_text(Path(path))
            if content is None:
                continue
            loaded.append(
                RagFragment(
                    path=path,
                    content=content,
                    score=0.0,
                    source=FragmentSource.FOLDER,
                )
            )
        return loaded

    def _score_buffers(self, query: str) -> tuple[RagFragment, ...]:
        """Score the in-memory open buffers, independent of any shard."""
        if not self._open_buffers:
            return ()
        candidates = [(b.path, b.content) for b in self._open_buffers]
        scores = self._score(query, candidates)
        out = [
            RagFragment(
                path=path,
                content=content,
                score=_clamp_unit(raw),
                source=FragmentSource.BUFFER,
            )
            for (path, content), raw in zip(candidates, scores, strict=True)
            if _clamp_unit(raw) >= self._threshold
        ]
        out.sort(key=lambda fragment: (-fragment.score, fragment.path))
        return tuple(out)

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
