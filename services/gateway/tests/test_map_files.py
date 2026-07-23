"""Unit tests for the MAP_FILES stage logic in ``steering_compiler.py`` (§2.3).

Covers the file-selection stage end to end at the library level:

* ``model_file_selector`` — the deterministic model adapter,
* ``select_map_files`` — prompt build, JSON parsing (incl. fenced/prose
  tolerance), workspace-root validation, the max-8 read cap, path
  normalisation/de-duplication, empty selections, and event emission,
* ``build_read_files_payload`` — the ``=== FILE: {path} ===`` framing, the
  2000-token per-file cap + ``... [truncated]`` marker, and skip-on-unreadable,
* ``preapproved_writes`` / ``is_write_preapproved`` — the APPLY_EDITS write
  allowlist.

Path validation uses a real ``tmp_path`` workspace root; token math uses the
deterministic char-per-token estimate so truncation assertions are exact.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from zocai_gateway.context.rag_matcher import FragmentSource, RagFragment
from zocai_gateway.context.steering_compiler import (
    MAP_FILES_INSTRUCTION,
    MAX_READ_FILES,
    PER_FILE_TOKEN_CAP,
    TRUNCATION_MARKER,
    MapFilesError,
    MapFilesEvent,
    build_read_files_payload,
    is_write_preapproved,
    model_file_selector,
    preapproved_writes,
    select_map_files,
)
from zocai_gateway.context.token_gate import CHARS_PER_TOKEN
from zocai_gateway.model_interface import (
    ModelRequest,
    ModelResponse,
    ModelTier,
    TokenChunk,
)


class _RecordingModel:
    """Minimal :class:`ModelInterface` stub: echoes a reply, records requests."""

    def __init__(self, reply: str, window: int = 128_000) -> None:
        self.reply = reply
        self._window = window
        self.requests: list[ModelRequest] = []

    def generate(self, req: ModelRequest) -> ModelResponse:
        self.requests.append(req)
        return ModelResponse(text=self.reply, tier=ModelTier.CLOUD)

    def stream(self, req: ModelRequest) -> Iterator[TokenChunk]:
        yield TokenChunk(text=self.reply, done=True)

    @property
    def tier(self) -> ModelTier:
        return ModelTier.CLOUD

    @property
    def context_window(self) -> int:
        return self._window


# -- prompt / constants -----------------------------------------------------


def test_map_files_instruction_matches_prompt() -> None:
    assert MAP_FILES_INSTRUCTION.startswith("You are a senior engineer.")
    assert "select the MINIMUM set of files to read (max 8)" in MAP_FILES_INSTRUCTION
    assert "CREATE or MODIFY" in MAP_FILES_INSTRUCTION
    assert "Output JSON: { read: [path], write: [path], rationale: str }" in MAP_FILES_INSTRUCTION


def test_stage_constants() -> None:
    assert MAX_READ_FILES == 8
    assert PER_FILE_TOKEN_CAP == 2000
    assert TRUNCATION_MARKER == "... [truncated]"


# -- model_file_selector (step 2) -------------------------------------------


def test_model_file_selector_calls_model_deterministically() -> None:
    model = _RecordingModel(reply='{"read": [], "write": [], "rationale": ""}')
    select = model_file_selector(model)

    out = select("THE PROMPT")

    assert out == model.reply
    assert len(model.requests) == 1
    request = model.requests[0]
    assert request.prompt == "THE PROMPT"
    assert request.temperature == 0.0  # deterministic
    assert request.max_tokens == 800
    assert request.context_window == model.context_window


def test_model_file_selector_honours_overrides() -> None:
    model = _RecordingModel(reply="{}")
    model_file_selector(model, context_window=4096, max_tokens=256)("p")

    request = model.requests[0]
    assert request.context_window == 4096
    assert request.max_tokens == 256


# -- select_map_files: happy path + prompt (steps 1-4) ----------------------


def test_select_map_files_happy_path(tmp_path: Path) -> None:
    captured: dict[str, str] = {}

    def select(prompt: str) -> str:
        captured["prompt"] = prompt
        return json.dumps(
            {
                "read": ["src/a.py", "src/b.py"],
                "write": ["src/c.py"],
                "rationale": "touches a, b; creates c",
            }
        )

    event = select_map_files(
        "implement the widget",
        ["src/a.py", "src/b.py"],
        select=select,
        workspace_root=tmp_path,
    )

    assert isinstance(event, MapFilesEvent)
    assert event.read_list == ("src/a.py", "src/b.py")
    assert event.write_list == ("src/c.py",)
    assert event.rationale == "touches a, b; creates c"

    prompt = captured["prompt"]
    assert MAP_FILES_INSTRUCTION in prompt
    assert "implement the widget" in prompt  # the task
    assert "- src/a.py" in prompt  # candidate bullets
    assert "- src/b.py" in prompt


def test_select_map_files_renders_fragment_candidates_deduped(tmp_path: Path) -> None:
    captured: dict[str, str] = {}

    def select(prompt: str) -> str:
        captured["prompt"] = prompt
        return '{"read": [], "write": [], "rationale": ""}'

    candidates = [
        RagFragment(path="src/a.py", content="x", score=0.9, source=FragmentSource.FOLDER),
        RagFragment(path="src/a.py", content="y", score=0.8, source=FragmentSource.FOLDER),
        "src/b.py",
    ]
    select_map_files("t", candidates, select=select, workspace_root=tmp_path)

    prompt = captured["prompt"]
    assert prompt.count("- src/a.py") == 1  # duplicate path rendered once
    assert "- src/b.py" in prompt


# -- select_map_files: validation, capping, normalisation (step 3) ----------


def test_select_map_files_caps_read_list_to_eight(tmp_path: Path) -> None:
    reads = [f"src/f{i}.py" for i in range(12)]
    event = select_map_files(
        "t",
        [],
        select=lambda _p: json.dumps({"read": reads, "write": [], "rationale": ""}),
        workspace_root=tmp_path,
    )

    assert len(event.read_list) == MAX_READ_FILES == 8
    assert event.read_list == tuple(reads[:8])


def test_select_map_files_drops_paths_outside_workspace(tmp_path: Path) -> None:
    event = select_map_files(
        "t",
        [],
        select=lambda _p: json.dumps(
            {
                "read": ["src/ok.py", "../escape.py", "/etc/passwd"],
                "write": ["also/ok.py", "../../evil.py"],
                "rationale": "r",
            }
        ),
        workspace_root=tmp_path,
    )

    assert event.read_list == ("src/ok.py",)
    assert event.write_list == ("also/ok.py",)


def test_select_map_files_normalizes_and_dedupes_paths(tmp_path: Path) -> None:
    event = select_map_files(
        "t",
        [],
        select=lambda _p: json.dumps(
            {"read": ["src/a.py", "./src/a.py", "src/./a.py"], "write": [], "rationale": ""}
        ),
        workspace_root=tmp_path,
    )

    assert event.read_list == ("src/a.py",)


def test_select_map_files_allows_empty_selection(tmp_path: Path) -> None:
    event = select_map_files(
        "t",
        [],
        select=lambda _p: '{"read": [], "write": [], "rationale": "nothing needed"}',
        workspace_root=tmp_path,
    )

    assert event.read_list == ()
    assert event.write_list == ()
    assert event.rationale == "nothing needed"


def test_select_map_files_non_string_rationale_becomes_empty(tmp_path: Path) -> None:
    event = select_map_files(
        "t",
        [],
        select=lambda _p: '{"read": [], "write": [], "rationale": 123}',
        workspace_root=tmp_path,
    )

    assert event.rationale == ""


# -- select_map_files: emission (step 4) ------------------------------------


def test_select_map_files_emits_event(tmp_path: Path) -> None:
    events: list[MapFilesEvent] = []
    event = select_map_files(
        "t",
        [],
        select=lambda _p: '{"read": ["a.py"], "write": [], "rationale": "r"}',
        workspace_root=tmp_path,
        emit=events.append,
    )

    assert events == [event]


# -- select_map_files: JSON parsing tolerance & errors ----------------------


@pytest.mark.parametrize(
    "raw",
    [
        '{"read": ["a.py"], "write": [], "rationale": "r"}',
        '```json\n{"read": ["a.py"], "write": [], "rationale": "r"}\n```',
        '```\n{"read": ["a.py"], "write": [], "rationale": "r"}\n```',
        'Sure! Here is the plan:\n{"read": ["a.py"], "write": [], "rationale": "r"}\ndone.',
    ],
)
def test_select_map_files_tolerates_wrapped_json(tmp_path: Path, raw: str) -> None:
    event = select_map_files("t", [], select=lambda _p: raw, workspace_root=tmp_path)

    assert event.read_list == ("a.py",)
    assert event.rationale == "r"


def test_select_map_files_raises_on_unparseable_output(tmp_path: Path) -> None:
    with pytest.raises(MapFilesError):
        select_map_files("t", [], select=lambda _p: "not json at all", workspace_root=tmp_path)


def test_select_map_files_raises_when_json_is_not_an_object(tmp_path: Path) -> None:
    with pytest.raises(MapFilesError):
        select_map_files("t", [], select=lambda _p: "[1, 2, 3]", workspace_root=tmp_path)


# -- build_read_files_payload (step 5) --------------------------------------


def test_build_read_files_payload_frames_each_file() -> None:
    files = {"a.py": "print('a')", "b.py": "print('b')"}
    payload = build_read_files_payload(["a.py", "b.py"], lambda path: files[path])

    assert payload == "=== FILE: a.py ===\nprint('a')\n=== FILE: b.py ===\nprint('b')\n"


def test_build_read_files_payload_keeps_small_file_intact() -> None:
    small = "y" * 40
    payload = build_read_files_payload(["s.py"], lambda _p: small)

    assert payload == f"=== FILE: s.py ===\n{small}\n"
    assert TRUNCATION_MARKER not in payload


def test_build_read_files_payload_truncates_over_the_cap() -> None:
    cap_chars = PER_FILE_TOKEN_CAP * CHARS_PER_TOKEN  # 8000 chars == 2000 tokens
    big = "x" * (cap_chars + 100)  # 2025 tokens > cap
    payload = build_read_files_payload(["big.py"], lambda _p: big)

    assert payload.startswith("=== FILE: big.py ===\n")
    assert payload.endswith(f"\n{TRUNCATION_MARKER}\n")
    suffix = f"\n{TRUNCATION_MARKER}"
    body_chars = cap_chars - len(suffix)
    # The truncation marker is included inside the file's total token budget.
    assert ("x" * body_chars) in payload
    assert ("x" * (body_chars + 1)) not in payload


def test_build_read_files_payload_zero_cap_yields_marker_only() -> None:
    payload = build_read_files_payload(["a.py"], lambda _p: "content", token_cap=0)

    assert payload == f"=== FILE: a.py ===\n{TRUNCATION_MARKER}\n"


def test_build_read_files_payload_skips_unreadable_files() -> None:
    def read_file(path: str) -> str:
        if path == "bad.py":
            raise OSError("cannot read")
        return "ok"

    payload = build_read_files_payload(["bad.py", "good.py"], read_file)

    assert "bad.py" not in payload
    assert payload == "=== FILE: good.py ===\nok\n"


# -- preapproved_writes / is_write_preapproved (step 6) ---------------------


def test_preapproved_writes_is_the_write_list_set() -> None:
    event = MapFilesEvent(read_list=(), write_list=("src/a.py", "src/b.py"), rationale="")

    assert preapproved_writes(event) == frozenset({"src/a.py", "src/b.py"})


def test_is_write_preapproved_membership(tmp_path: Path) -> None:
    allow = frozenset({"src/a.py"})

    assert is_write_preapproved("src/a.py", allow, workspace_root=tmp_path) is True
    assert is_write_preapproved("src/b.py", allow, workspace_root=tmp_path) is False


def test_is_write_preapproved_normalizes_before_matching(tmp_path: Path) -> None:
    allow = frozenset({"src/a.py"})

    # A "./"-prefixed and an absolute-within-root spelling both match the key.
    assert is_write_preapproved("./src/a.py", allow, workspace_root=tmp_path) is True
    assert is_write_preapproved(tmp_path / "src" / "a.py", allow, workspace_root=tmp_path) is True


def test_is_write_preapproved_rejects_escaping_path(tmp_path: Path) -> None:
    allow = frozenset({"src/a.py"})

    assert is_write_preapproved("../a.py", allow, workspace_root=tmp_path) is False


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
