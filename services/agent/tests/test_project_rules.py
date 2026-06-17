"""Project rules (.zoc/rules): per-project conventions injected into the agent
system prompt, with an endpoint exposing what's active."""

from __future__ import annotations

from llama_studio_agent.agent.project_rules import (
    MAX_RULES_BYTES,
    collect_rule_sources,
    load_project_rules,
)


def _ws(tmp_path, files: dict[str, str]):
    for rel, content in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return str(tmp_path)


def test_no_rules_returns_empty(tmp_path):
    root = _ws(tmp_path, {"src/main.py": "x = 1\n"})
    assert collect_rule_sources(root) == []
    assert load_project_rules(root) == ""


def test_single_rules_file_is_loaded(tmp_path):
    root = _ws(tmp_path, {".zoc/rules.md": "Always use tabs.\n"})
    sources = collect_rule_sources(root)
    assert [s[0] for s in sources] == [".zoc/rules.md"]
    block = load_project_rules(root)
    assert "Always use tabs." in block
    assert "Project rules" in block


def test_rules_directory_files_sorted_and_combined(tmp_path):
    root = _ws(
        tmp_path,
        {
            ".zoc/rules/2-style.md": "Two spaces.",
            ".zoc/rules/1-arch.md": "Layered architecture.",
        },
    )
    sources = collect_rule_sources(root)
    # Sorted by filename: 1-arch before 2-style.
    assert [s[0] for s in sources] == [".zoc/rules/1-arch.md", ".zoc/rules/2-style.md"]
    block = load_project_rules(root)
    assert "Layered architecture." in block
    assert "Two spaces." in block
    assert block.index("Layered") < block.index("Two spaces")


def test_zoc_rules_take_priority_over_legacy(tmp_path):
    root = _ws(
        tmp_path,
        {".zoc/rules.md": "Zoc rule.", "AGENTS.md": "Legacy rule.", ".cursorrules": "Cursor rule."},
    )
    sources = collect_rule_sources(root)
    assert [s[0] for s in sources] == [".zoc/rules.md"]
    assert "Legacy rule." not in load_project_rules(root)


def test_legacy_fallback_when_no_zoc_rules(tmp_path):
    root = _ws(tmp_path, {"AGENTS.md": "Follow the style guide."})
    sources = collect_rule_sources(root)
    assert [s[0] for s in sources] == ["AGENTS.md"]
    assert "Follow the style guide." in load_project_rules(root)


def test_rules_are_truncated_when_huge(tmp_path):
    root = _ws(tmp_path, {".zoc/rules.md": "x" * (MAX_RULES_BYTES + 5000)})
    block = load_project_rules(root)
    assert "truncated" in block
    # Bounded (block adds a short prefix/suffix beyond the cap).
    assert len(block) < MAX_RULES_BYTES + 500


def test_rules_endpoint_reports_active_sources(client, session, tmp_workspace):
    (tmp_workspace / ".zoc").mkdir(parents=True, exist_ok=True)
    (tmp_workspace / ".zoc" / "rules.md").write_text("Prefer composition.")

    resp = client.get(f"/v1/sessions/{session.id}/rules")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["active"] is True
    assert body["sources"] == [".zoc/rules.md"]
    assert "Prefer composition." in body["rules"]


def test_rules_endpoint_inactive_when_absent(client, session, tmp_workspace):
    resp = client.get(f"/v1/sessions/{session.id}/rules")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["active"] is False
    assert body["sources"] == []
