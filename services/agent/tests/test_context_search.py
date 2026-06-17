"""Context search for the @ mention picker — file/folder fuzzy ranking."""

from __future__ import annotations

from llama_studio_agent.agent.context_search import fuzzy_score, search_files


def _ws(tmp_path, files):
    for rel in files:
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x\n")
    return str(tmp_path)


def test_fuzzy_score_substring_beats_subsequence_and_basename_wins():
    s_sub = fuzzy_score("util", "src/utils.ts")  # substring, basename
    s_seq = fuzzy_score("uts", "src/utils.ts")  # subsequence only
    assert s_sub is not None and s_seq is not None
    assert s_sub > s_seq
    # Non-match returns None.
    assert fuzzy_score("zzz", "src/utils.ts") is None
    # Empty query matches everything with a neutral score.
    assert fuzzy_score("", "anything") == 0.5


def test_search_files_ranks_matches_and_includes_folders(tmp_path):
    root = _ws(tmp_path, ["src/app.ts", "src/utils/format.ts", "README.md"])
    out = search_files(root, "format", limit=25)
    paths = [c["path"] for c in out]
    assert "src/utils/format.ts" in paths
    # The file matching the query ranks first.
    assert out[0]["path"] == "src/utils/format.ts"
    assert out[0]["kind"] == "file"
    # README doesn't match "format".
    assert "README.md" not in paths


def test_search_files_returns_folders_for_dir_query(tmp_path):
    root = _ws(tmp_path, ["src/app.ts", "src/utils/format.ts"])
    out = search_files(root, "utils", limit=25)
    kinds = {(c["kind"], c["path"]) for c in out}
    assert ("folder", "src/utils") in kinds


def test_search_files_empty_query_lists_some(tmp_path):
    root = _ws(tmp_path, ["a.ts", "b.ts"])
    out = search_files(root, "", limit=25)
    assert len(out) >= 2


def test_context_search_endpoint(client, session, tmp_workspace):
    (tmp_workspace / "lib").mkdir(exist_ok=True)
    (tmp_workspace / "lib" / "widget.ts").write_text("export const x = 1\n")

    resp = client.get(f"/v1/sessions/{session.id}/context/search?q=widget")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    paths = [c["path"] for c in body]
    assert "lib/widget.ts" in paths
    assert any(c["kind"] == "file" for c in body)
