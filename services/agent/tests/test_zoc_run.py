"""Isolated Agent-run workflow: review-before-apply (Zoc AI redesign).

An Agent-mode run with `reviewChanges=true` executes inside an isolated copy
of the workspace. The real project must NOT change until the user hits the
Apply endpoint; Discard throws the copy away leaving the real workspace
untouched.
"""

from __future__ import annotations

from llama_studio_agent.providers.base import ProviderToolCall
from llama_studio_agent.providers.mock import MockResponse


def _queue_write_run(mock_provider, *, path: str, content: str) -> None:
    write = ProviderToolCall(id="t1", name="write_file", arguments={"path": path, "content": content})
    mock_provider.reset()
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),  # planner
        MockResponse(text="", tool_calls=[write]),
        MockResponse(text="done"),
    )


def test_isolated_run_applies_to_real_workspace_only_on_apply(
    client, session, mock_provider, tmp_workspace
):
    _queue_write_run(mock_provider, path="new_feature.py", content="print('hi')\n")

    resp = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={
            "message": "add a feature",
            "workspacePath": str(tmp_workspace),
            "mode": "agent",
            "reviewChanges": True,
        },
    )
    assert resp.status_code == 200, resp.text
    review = resp.json()["review"]
    assert review is not None
    run_id = review["run_id"]
    assert review["status"] == "awaiting_review"
    assert "new_feature.py" in review["changed_files"]

    # The real workspace is untouched while the run awaits review.
    assert not (tmp_workspace / "new_feature.py").exists()

    applied = client.post(f"/v1/sessions/{session.id}/agent/runs/{run_id}/apply")
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "applied"
    # Now the change has landed on the real workspace.
    assert (tmp_workspace / "new_feature.py").read_text() == "print('hi')\n"


def test_isolated_run_discard_leaves_real_workspace_untouched(
    client, session, mock_provider, tmp_workspace
):
    _queue_write_run(mock_provider, path="scratch.py", content="x = 1\n")

    resp = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={
            "message": "add a feature",
            "workspacePath": str(tmp_workspace),
            "mode": "agent",
            "reviewChanges": True,
        },
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["review"]["run_id"]

    discarded = client.post(f"/v1/sessions/{session.id}/agent/runs/{run_id}/discard")
    assert discarded.status_code == 200, discarded.text
    assert discarded.json()["status"] == "discarded"
    assert not (tmp_workspace / "scratch.py").exists()

    # The run is gone — applying it afterwards is a 404.
    again = client.post(f"/v1/sessions/{session.id}/agent/runs/{run_id}/apply")
    assert again.status_code == 404


def test_non_review_run_writes_directly_and_has_no_review(
    client, session, mock_provider, tmp_workspace
):
    # Without reviewChanges, behavior is unchanged: writes hit the real
    # workspace directly and the response carries no review object.
    _queue_write_run(mock_provider, path="direct.py", content="y = 2\n")

    resp = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={
            "message": "add a feature",
            "workspacePath": str(tmp_workspace),
            "mode": "agent",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["review"] is None
    assert (tmp_workspace / "direct.py").read_text() == "y = 2\n"


def test_discard_removes_temp_workspace_and_registry_entry(tmp_path):
    """The cleanup primitive the run error-path relies on: discarding an
    isolated run wipes its temp workspace from disk and drops the registry
    entry, so a failed/cancelled run can't leak memory or disk."""
    from uuid import uuid4

    from llama_studio_agent.agent.zoc_run import (
        discard_isolated_run,
        get_run,
        prepare_isolated_run,
    )

    source = tmp_path / "src"
    source.mkdir()
    (source / "a.txt").write_text("hello\n")
    sid = uuid4()

    run = prepare_isolated_run(
        data_dir=str(tmp_path / "data"),
        run_id="leak-test",
        session_id=sid,
        source_root=source,
    )
    assert run.workspace.exists()
    assert get_run("leak-test", sid) is run

    discard_isolated_run(run)

    # Temp copy gone from disk and registry — no leak.
    assert not run.workspace.exists()
    assert not run.workspace.parent.exists()
    assert get_run("leak-test", sid) is None



# ---------------------------------------------------------------------------
# Module-level hardening / stress tests for the isolation primitives. These
# exercise prepare/apply/discard directly (no FastAPI client) so they're fast
# and deterministic.
# ---------------------------------------------------------------------------

from uuid import uuid4

import pytest

from llama_studio_agent.agent import zoc_run as zr
from llama_studio_agent.agent.workspace_diff import changed_files


def _make_source(tmp_path, files: dict[str, str]):
    """Create a source workspace with the given {relpath: content} files."""
    source = tmp_path / "src"
    source.mkdir()
    for rel, content in files.items():
        p = source / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return source


def test_prepare_rejects_missing_source(tmp_path):
    with pytest.raises(ValueError):
        zr.prepare_isolated_run(
            data_dir=str(tmp_path / "data"),
            run_id="r-missing",
            session_id=uuid4(),
            source_root=tmp_path / "does-not-exist",
        )


def test_changed_files_detects_add_modify_delete(tmp_path):
    source = _make_source(tmp_path, {"keep.py": "k\n", "mod.py": "old\n", "gone.py": "bye\n"})
    run = zr.prepare_isolated_run(
        data_dir=str(tmp_path / "data"), run_id="r1", session_id=uuid4(), source_root=source
    )
    # Mutate the isolated copy: modify, delete, add.
    (run.workspace / "mod.py").write_text("new\n")
    (run.workspace / "gone.py").unlink()
    (run.workspace / "added.py").write_text("hi\n")

    changed = set(changed_files(source, run.workspace))
    assert changed == {"mod.py", "gone.py", "added.py"}
    assert "keep.py" not in changed
    zr.discard_isolated_run(run)


def test_changed_files_size_shortcut_and_byte_compare(tmp_path):
    # Same content → unchanged; same size but different bytes → changed;
    # different size → changed. Validates the size short-circuit still falls
    # back to a byte comparison for equal-size files.
    source = _make_source(tmp_path, {"same.txt": "abc\n", "swap.txt": "abc\n", "grow.txt": "a\n"})
    run = zr.prepare_isolated_run(
        data_dir=str(tmp_path / "data"), run_id="r2", session_id=uuid4(), source_root=source
    )
    (run.workspace / "swap.txt").write_text("xyz\n")  # same length, different bytes
    (run.workspace / "grow.txt").write_text("aaaa\n")  # different length

    changed = set(changed_files(source, run.workspace))
    assert changed == {"swap.txt", "grow.txt"}
    zr.discard_isolated_run(run)


def test_apply_partial_failure_records_failures_and_cleans_up(tmp_path, monkeypatch):
    source = _make_source(tmp_path, {"ok.py": "o\n", "bad.py": "b\n"})
    run = zr.prepare_isolated_run(
        data_dir=str(tmp_path / "data"), run_id="r3", session_id=uuid4(), source_root=source
    )
    (run.workspace / "ok.py").write_text("o2\n")
    (run.workspace / "bad.py").write_text("b2\n")
    workspace_parent = run.workspace.parent

    real_copy = zr.shutil.copy2

    def flaky_copy(src, dst, *a, **k):
        if str(src).endswith("bad.py"):
            raise OSError("simulated write failure")
        return real_copy(src, dst, *a, **k)

    monkeypatch.setattr(zr.shutil, "copy2", flaky_copy)

    applied = zr.apply_isolated_run(run)

    # The good file landed; the bad one is reported, not silently dropped.
    assert applied == ["ok.py"]
    assert run.failed == ["bad.py"]
    assert run.status == "error"
    assert (source / "ok.py").read_text() == "o2\n"
    assert (source / "bad.py").read_text() == "b\n"  # unchanged on failure
    # No leak: registry entry + temp dir gone even after partial failure.
    assert zr.get_run("r3", run.session_id) is None
    assert not workspace_parent.exists()


def test_stress_many_nested_files_apply(tmp_path):
    # 150 files across nested dirs; modify 40, add 10, delete 5, then apply
    # and assert the real workspace exactly reflects the isolated copy.
    files = {f"pkg/mod_{i}/file_{i}.py": f"v{i}\n" for i in range(150)}
    source = _make_source(tmp_path, files)
    run = zr.prepare_isolated_run(
        data_dir=str(tmp_path / "data"), run_id="r4", session_id=uuid4(), source_root=source
    )

    for i in range(40):
        (run.workspace / f"pkg/mod_{i}/file_{i}.py").write_text(f"changed{i}\n")
    for i in range(150, 160):
        p = run.workspace / f"pkg/new/file_{i}.py"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(f"new{i}\n")
    for i in range(145, 150):
        (run.workspace / f"pkg/mod_{i}/file_{i}.py").unlink()

    applied = zr.apply_isolated_run(run)

    assert run.failed == []
    assert run.status == "applied"
    assert len(applied) == 40 + 10 + 5
    # Spot-check each kind of change landed on the real workspace.
    assert (source / "pkg/mod_0/file_0.py").read_text() == "changed0\n"
    assert (source / "pkg/new/file_155.py").read_text() == "new155\n"
    assert not (source / "pkg/mod_147/file_147.py").exists()
    assert (source / "pkg/mod_100/file_100.py").read_text() == "v100\n"  # untouched
    # Cleaned up.
    assert zr.get_run("r4", run.session_id) is None


def test_discard_after_apply_is_safe_noop(tmp_path):
    # Defensive: discarding an already-applied (and cleaned-up) run must not
    # raise even though the temp dir is gone.
    source = _make_source(tmp_path, {"a.py": "1\n"})
    run = zr.prepare_isolated_run(
        data_dir=str(tmp_path / "data"), run_id="r5", session_id=uuid4(), source_root=source
    )
    (run.workspace / "a.py").write_text("2\n")
    zr.apply_isolated_run(run)
    # Second resolution is a harmless no-op (rmtree ignores missing dirs).
    zr.discard_isolated_run(run)
    assert run.status in ("applied", "discarded")


def test_apply_endpoint_reports_failure_when_write_fails(
    client, session, mock_provider, tmp_workspace, monkeypatch
):
    """If every file fails to write to the real workspace, the apply endpoint
    returns 500 and the real workspace is left untouched."""
    _queue_write_run(mock_provider, path="cant_write.py", content="z = 9\n")

    resp = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={
            "message": "add a feature",
            "workspacePath": str(tmp_workspace),
            "mode": "agent",
            "reviewChanges": True,
        },
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["review"]["run_id"]

    def always_fail(src, dst, *a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(zr.shutil, "copy2", always_fail)

    applied = client.post(f"/v1/sessions/{session.id}/agent/runs/{run_id}/apply")
    assert applied.status_code == 500, applied.text
    # The real workspace never received the change.
    assert not (tmp_workspace / "cant_write.py").exists()
    # The run was cleaned up — a second apply is a 404, never a partial replay.
    again = client.post(f"/v1/sessions/{session.id}/agent/runs/{run_id}/apply")
    assert again.status_code == 404
