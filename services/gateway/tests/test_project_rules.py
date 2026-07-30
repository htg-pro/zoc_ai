"""Unit tests for project-rules discovery (task 9.4, R30.1–R30.3).

Discovery is the Workspace_Services half of the system-instruction assembler:
the Agent_Runtime asks for sources and their contents and orders them itself
(design.md:1525 — "The runtime does not walk the tree itself"). These tests
pin the three facts the runtime depends on: every convention is found at any
depth, the result is deterministic, and an unreadable file is reported rather
than raised.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from zocai_gateway.app import create_app
from zocai_gateway.context.project_rules import (
    MAX_RULE_BYTES,
    MAX_RULE_FILES,
    discover_project_rules,
    discover_rule_documents,
)


def _write(root: Path, rel: str, content: str = "rule text") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _paths(root: Path) -> list[str]:
    return [d.path for d in discover_rule_documents(root)]


def test_missing_root_yields_no_documents(tmp_path: Path) -> None:
    assert discover_rule_documents(tmp_path / "nope") == []


def test_empty_workspace_is_inactive(tmp_path: Path) -> None:
    info = discover_project_rules(tmp_path)
    assert info.active is False
    assert info.sources == []
    assert info.rules == ""
    assert info.documents == []


def test_finds_all_three_conventions(tmp_path: Path) -> None:
    _write(tmp_path, ".zoc/rules/style.md")
    _write(tmp_path, ".cursor/rules/legacy.mdc")
    _write(tmp_path, "AGENTS.md")

    assert _paths(tmp_path) == [
        ".cursor/rules/legacy.mdc",
        ".zoc/rules/style.md",
        "AGENTS.md",
    ]


def test_finds_nested_variants(tmp_path: Path) -> None:
    """A rule beside the code it governs is the point of a nested rule."""
    _write(tmp_path, "src/.zoc/rules/api.md")
    _write(tmp_path, "packages/ui/AGENTS.md")
    _write(tmp_path, ".zoc/rules/deep/nested/scoped.md")

    assert _paths(tmp_path) == [
        ".zoc/rules/deep/nested/scoped.md",
        "packages/ui/AGENTS.md",
        "src/.zoc/rules/api.md",
    ]


def test_ignores_non_rule_extensions_and_stray_files(tmp_path: Path) -> None:
    _write(tmp_path, ".zoc/rules/keep.md")
    _write(tmp_path, ".zoc/rules/skip.txt")
    _write(tmp_path, ".zoc/rules/skip.json")
    _write(tmp_path, ".zoc/steering/not-a-rule.md")
    _write(tmp_path, "README.md")

    assert _paths(tmp_path) == [".zoc/rules/keep.md"]


def test_uppercase_extension_is_matched(tmp_path: Path) -> None:
    _write(tmp_path, ".zoc/rules/SHOUTED.MD")
    assert _paths(tmp_path) == [".zoc/rules/SHOUTED.MD"]


def test_skips_vendor_and_cache_directories(tmp_path: Path) -> None:
    """A dependency's rules are not this project's rules."""
    _write(tmp_path, "node_modules/pkg/.zoc/rules/theirs.md")
    _write(tmp_path, "node_modules/pkg/AGENTS.md")
    _write(tmp_path, "target/debug/AGENTS.md")
    _write(tmp_path, ".git/AGENTS.md")
    _write(tmp_path, ".venv/lib/AGENTS.md")
    _write(tmp_path, ".zoc/rules/ours.md")

    assert _paths(tmp_path) == [".zoc/rules/ours.md"]


def test_discovery_is_deterministic(tmp_path: Path) -> None:
    for name in ("c.md", "a.md", "b.md"):
        _write(tmp_path, f".zoc/rules/{name}")
    first = _paths(tmp_path)
    assert first == [".zoc/rules/a.md", ".zoc/rules/b.md", ".zoc/rules/c.md"]
    assert first == _paths(tmp_path)


def test_unreadable_file_is_reported_not_raised(tmp_path: Path) -> None:
    _write(tmp_path, ".zoc/rules/good.md", "usable")
    bad = _write(tmp_path, ".zoc/rules/bad.md", "unreadable")
    bad.chmod(0o000)
    if os.access(bad, os.R_OK):  # pragma: no cover - root ignores the mode bits
        pytest.skip("cannot make a file unreadable as this user")
    try:
        documents = {d.path: d for d in discover_rule_documents(tmp_path)}
    finally:
        bad.chmod(0o644)

    assert documents[".zoc/rules/good.md"].content == "usable"
    failed = documents[".zoc/rules/bad.md"]
    assert failed.content is None
    assert failed.error


def test_non_utf8_file_is_reported(tmp_path: Path) -> None:
    path = tmp_path / ".zoc" / "rules" / "binary.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfe not text")

    (document,) = discover_rule_documents(tmp_path)
    assert document.content is None
    assert document.error == "The file is not valid UTF-8 text."


def test_oversize_file_is_reported_without_being_read(tmp_path: Path) -> None:
    _write(tmp_path, ".zoc/rules/huge.md", "x" * (MAX_RULE_BYTES + 1))

    (document,) = discover_rule_documents(tmp_path)
    assert document.content is None
    assert str(MAX_RULE_BYTES) in (document.error or "")


def test_file_count_is_bounded_and_the_cut_is_stable(tmp_path: Path) -> None:
    for index in range(MAX_RULE_FILES + 25):
        _write(tmp_path, f".zoc/rules/rule-{index:04d}.md")

    documents = discover_rule_documents(tmp_path)
    assert len(documents) == MAX_RULE_FILES
    assert documents[0].path == ".zoc/rules/rule-0000.md"
    assert documents[-1].path == f".zoc/rules/rule-{MAX_RULE_FILES - 1:04d}.md"


def test_active_only_when_a_source_produced_text(tmp_path: Path) -> None:
    """A workspace whose only rule file is empty does not claim rules apply."""
    _write(tmp_path, ".zoc/rules/blank.md", "   \n\t\n")

    info = discover_project_rules(tmp_path)
    assert info.active is False
    assert info.sources == []
    assert info.rules == ""
    assert [d.path for d in info.documents] == [".zoc/rules/blank.md"]


def test_wire_model_carries_both_shapes(tmp_path: Path) -> None:
    """`sources`/`rules` keep serving the renderer; `documents` serves the runtime."""
    _write(tmp_path, ".zoc/rules/one.md", "first")
    _write(tmp_path, "AGENTS.md", "second")
    _write(tmp_path, ".cursor/rules/broken.md", "")

    info = discover_project_rules(tmp_path)
    assert info.active is True
    assert info.sources == [".zoc/rules/one.md", "AGENTS.md"]
    assert info.rules == "first\n\nsecond"
    assert [d.path for d in info.documents] == [
        ".cursor/rules/broken.md",
        ".zoc/rules/one.md",
        "AGENTS.md",
    ]


def test_symlinked_directories_are_not_followed(tmp_path: Path) -> None:
    """A self-referential link must not turn discovery into an infinite walk."""
    _write(tmp_path, ".zoc/rules/real.md")
    link = tmp_path / "loop"
    try:
        link.symlink_to(tmp_path, target_is_directory=True)
    except (OSError, NotImplementedError):  # pragma: no cover - platform-dependent
        pytest.skip("symlinks unavailable")

    assert _paths(tmp_path) == [".zoc/rules/real.md"]


# ── The endpoint the Agent_Runtime calls ──────────────────────────────────────
# `apps/frontend/src/lib/agent-client.ts` has called `GET /v1/sessions/{id}/rules`
# all along; task 9.4 is the first consumer that needs it to exist.


def test_rules_route_is_registered() -> None:
    app = create_app()
    paths = {route.path for route in app.routes}  # type: ignore[attr-defined]
    assert "/v1/sessions/{session_id}/rules" in paths


def test_rules_endpoint_returns_discovered_documents(tmp_path: Path) -> None:
    _write(tmp_path, ".zoc/rules/style.md", "prefer clarity")
    _write(tmp_path, "AGENTS.md", "run the tests")

    with TestClient(create_app(workspace_root=tmp_path)) as client:
        session = client.post(
            "/v1/sessions",
            json={"title": "rules", "workspace_root": str(tmp_path)},
        ).json()
        response = client.get(f"/v1/sessions/{session['id']}/rules")

    assert response.status_code == 200
    body = response.json()
    assert body["active"] is True
    assert body["sources"] == [".zoc/rules/style.md", "AGENTS.md"]
    assert [d["path"] for d in body["documents"]] == [".zoc/rules/style.md", "AGENTS.md"]
    assert body["documents"][0]["content"] == "prefer clarity"
    assert body["documents"][0]["error"] is None


def test_rules_endpoint_404s_for_an_unknown_session(tmp_path: Path) -> None:
    with TestClient(create_app(workspace_root=tmp_path)) as client:
        response = client.get("/v1/sessions/does-not-exist/rules")
    assert response.status_code == 404
