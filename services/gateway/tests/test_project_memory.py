"""Tests for persistent project memory (§14.1) and approach learning (§14.2)."""

from __future__ import annotations

import json
from pathlib import Path

from zocai_gateway.memory.hermes_evolution import (
    APPROACH_WEIGHTS_FILE,
    HermesEvolution,
    classify_task,
    extract_approach,
)
from zocai_gateway.memory.matrix import MemoryMatrix
from zocai_gateway.memory.project_memory import (
    MAX_FACTS,
    MEMORY_FILE,
    MemoryFact,
    ProjectMemoryStore,
    fact_similarity,
    parse_extracted_facts,
    render_memory_prompt,
    top_facts,
    workspace_hash,
)


def _store(tmp_path: Path) -> ProjectMemoryStore:
    return ProjectMemoryStore(tmp_path / "ws", root=tmp_path / "memroot")


# ── location + persistence ───────────────────────────────────────────────────


def test_workspace_hash_is_stable_and_path_independent_of_name(tmp_path: Path) -> None:
    first = workspace_hash(tmp_path)
    assert first == workspace_hash(tmp_path)
    assert len(first) == 16
    assert workspace_hash(tmp_path) != workspace_hash(tmp_path / "sub")


def test_memory_lives_under_the_hashed_directory(tmp_path: Path) -> None:
    store = _store(tmp_path)
    assert store.path.name == MEMORY_FILE
    assert store.path.parent.name == store.hash


def test_loading_a_missing_file_yields_empty_memory(tmp_path: Path) -> None:
    memory = _store(tmp_path).load()
    assert memory.facts == []
    assert memory.run_count == 0


def test_save_then_load_round_trips_every_field(tmp_path: Path) -> None:
    store = _store(tmp_path)
    memory = store.load()
    store.merge_facts(memory, ["The gateway binds to loopback only."], run_id="r1")
    store.record_file_summary(memory, "src/app.py", "FastAPI app factory.", run_id="r1")
    memory.preferences["test_command"] = "pytest -q"
    store.record_run(memory, tokens_used=1200)
    store.save(memory)

    reloaded = store.load()
    assert [f.fact for f in reloaded.facts] == ["The gateway binds to loopback only."]
    assert reloaded.file_summaries["src/app.py"].summary == "FastAPI app factory."
    assert reloaded.preferences["test_command"] == "pytest -q"
    assert reloaded.run_count == 1
    assert reloaded.total_tokens_used == 1200


def test_persisted_document_matches_the_documented_schema(tmp_path: Path) -> None:
    store = _store(tmp_path)
    memory = store.load()
    store.merge_facts(memory, ["A fact about the code."])
    store.save(memory)

    raw = json.loads(store.path.read_text(encoding="utf-8"))
    assert set(raw) == {
        "workspace_hash",
        "last_updated",
        "facts",
        "file_summaries",
        "preferences",
        "run_count",
        "total_tokens_used",
    }
    assert set(raw["facts"][0]) == {"fact", "source_run_id", "confidence", "created_at"}


def test_corrupt_memory_degrades_to_empty_instead_of_raising(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.directory.mkdir(parents=True)
    store.path.write_text("{not json", encoding="utf-8")
    assert store.load().facts == []


def test_partially_corrupt_memory_keeps_the_valid_entries(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.directory.mkdir(parents=True)
    store.path.write_text(
        json.dumps(
            {
                "workspace_hash": store.hash,
                "facts": [
                    {"fact": "good fact about handlers"},
                    {"fact": ""},
                    "not an object",
                ],
                "file_summaries": {"a.py": {"summary": "ok"}, "b.py": "junk"},
                "run_count": "not a number",
            }
        ),
        encoding="utf-8",
    )

    memory = store.load()
    assert [f.fact for f in memory.facts] == ["good fact about handlers"]
    assert list(memory.file_summaries) == ["a.py"]
    assert memory.run_count == 0


# ── de-duplication ───────────────────────────────────────────────────────────


def test_similarity_recognises_restatements() -> None:
    assert fact_similarity("The gateway binds to loopback", "The gateway binds to loopback") == 1.0
    assert (
        fact_similarity(
            "The gateway binds to loopback only",
            "Gateway binding is loopback only",
        )
        > 0.5
    )
    assert fact_similarity("The parser handles YAML", "Icons live in assets") < 0.2


def test_merging_a_restated_fact_raises_confidence_instead_of_duplicating(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    memory = store.load()
    assert store.merge_facts(memory, ["The gateway binds to loopback only."]) == 1
    before = memory.facts[0].confidence

    added = store.merge_facts(memory, ["The gateway binds to loopback only"])

    assert added == 0
    assert len(memory.facts) == 1
    assert memory.facts[0].confidence > before


def test_distinct_facts_all_land(tmp_path: Path) -> None:
    store = _store(tmp_path)
    memory = store.load()
    added = store.merge_facts(
        memory,
        [
            "The gateway binds to loopback only.",
            "Tests run with pytest from the repo root.",
            "The frontend uses zustand for state.",
        ],
    )
    assert added == 3
    assert len(memory.facts) == 3


def test_facts_are_capped(tmp_path: Path) -> None:
    store = _store(tmp_path)
    memory = store.load()
    store.merge_facts(
        memory, [f"Distinct fact number {i} about module{i}." for i in range(MAX_FACTS + 25)]
    )
    assert len(memory.facts) == MAX_FACTS


def test_blank_facts_are_ignored(tmp_path: Path) -> None:
    store = _store(tmp_path)
    memory = store.load()
    assert store.merge_facts(memory, ["", "   ", "\n"]) == 0
    assert memory.facts == []


# ── extraction parsing ───────────────────────────────────────────────────────


def test_parse_handles_numbered_bulleted_and_bare_lines() -> None:
    raw = """
    1. The gateway binds to loopback only.
    - Tests run with pytest.
    * The frontend uses zustand.
    The hot path lives in a Rust crate.
    """
    facts = parse_extracted_facts(raw)
    assert facts == [
        "The gateway binds to loopback only.",
        "Tests run with pytest.",
        "The frontend uses zustand.",
        "The hot path lives in a Rust crate.",
    ]


def test_parse_caps_at_five_and_drops_noise() -> None:
    raw = "\n".join([f"{i}. Fact number {i} about the code." for i in range(1, 9)])
    assert len(parse_extracted_facts(raw)) == 5
    assert parse_extracted_facts("ok\n-\n \n") == []


def test_parse_deduplicates_identical_lines() -> None:
    assert parse_extracted_facts("- Same fact here.\n- Same fact here.") == ["Same fact here."]


# ── prompt rendering ─────────────────────────────────────────────────────────


def test_prompt_uses_the_documented_header() -> None:
    prompt = render_memory_prompt([MemoryFact(fact="Tests run with pytest.")])
    assert prompt.startswith("Known facts about this project:")
    assert "- Tests run with pytest." in prompt


def test_prompt_is_empty_without_facts() -> None:
    assert render_memory_prompt([]) == ""


def test_top_facts_prefers_confidence_then_relevance() -> None:
    facts = [
        MemoryFact(fact="The parser handles YAML front matter.", confidence=0.4),
        MemoryFact(fact="Tests run with pytest from the repo root.", confidence=0.9),
    ]
    ranked = top_facts_for("", facts)
    assert ranked[0].fact.startswith("Tests run")

    # A query about the parser pulls the lower-confidence but relevant fact up.
    ranked_query = top_facts_for("fix the YAML parser", facts)
    assert "YAML" in ranked_query[0].fact


def top_facts_for(query: str, facts: list[MemoryFact]) -> list[MemoryFact]:
    from zocai_gateway.memory.project_memory import ProjectMemory

    memory = ProjectMemory(workspace_hash="h", facts=facts)
    return top_facts(memory, query=query or None)


def test_top_facts_respects_the_limit() -> None:
    from zocai_gateway.memory.project_memory import ProjectMemory

    memory = ProjectMemory(
        workspace_hash="h",
        facts=[MemoryFact(fact=f"Fact {i} about code.") for i in range(30)],
    )
    assert len(top_facts(memory)) == 10
    assert len(top_facts(memory, limit=3)) == 3


# ── §14.2 approach learning ──────────────────────────────────────────────────


def test_task_classification_buckets_common_intents() -> None:
    assert classify_task("Fix the crash in the parser") == "bugfix"
    assert classify_task("Add a test for the router") == "test"
    assert classify_task("Refactor the store") == "refactor"
    assert classify_task("Update the README docs") == "docs"
    assert classify_task("something entirely unrelated") == "general"


def test_extract_approach_picks_a_method_sentence() -> None:
    assert extract_approach(
        "Ran the tests. The approach was to add a guard clause first."
    ).startswith("The approach was")
    assert extract_approach("done") == ""
    assert extract_approach("") == ""


def _hermes(tmp_path: Path) -> HermesEvolution:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()
    return HermesEvolution(matrix)


def test_suggest_approach_is_none_without_history(tmp_path: Path) -> None:
    assert _hermes(tmp_path).suggest_approach("fix the parser") is None


def test_post_run_then_suggest_returns_the_successful_approach(tmp_path: Path) -> None:
    hermes = _hermes(tmp_path)
    transcript = "Fixed the crash. The approach was to validate input before parsing."
    for _ in range(3):
        hermes.post_run(transcript, "success")

    suggestion = hermes.suggest_approach("fix the crash in the parser")

    assert suggestion is not None
    assert "validate input" in str(suggestion["approach"])
    assert suggestion["successes"] == 3
    assert suggestion["task_type"] == "bugfix"


def test_failed_approaches_are_not_suggested(tmp_path: Path) -> None:
    hermes = _hermes(tmp_path)
    hermes.post_run("Fixed nothing. The approach was to delete the whole module.", "fail")
    assert hermes.suggest_approach("fix the crash") is None


def test_weights_are_persisted_as_readable_json(tmp_path: Path) -> None:
    hermes = _hermes(tmp_path)
    hermes.post_run("Added tests. The approach was to use table-driven cases.", "success")

    path = MemoryMatrix(tmp_path).hermes_evolution_dir / APPROACH_WEIGHTS_FILE
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert "test" in raw
    entry = next(iter(raw["test"].values()))
    assert entry == {"success": 1, "fail": 0}


def test_post_run_ignores_a_transcript_with_no_approach(tmp_path: Path) -> None:
    hermes = _hermes(tmp_path)
    hermes.post_run("ok", "success")
    assert hermes.suggest_approach("anything") is None
