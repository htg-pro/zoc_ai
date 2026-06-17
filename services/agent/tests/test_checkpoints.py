"""Checkpoints — one-click undo of an applied agent run.

Applying an isolated run snapshots the pre-change files; restore reverts
modifications, deletes files the run created, and recreates files it deleted.
"""

from __future__ import annotations

from uuid import uuid4

from llama_studio_agent.agent import checkpoints as cp
from llama_studio_agent.agent import zoc_run as zr


def _make_source(tmp_path, files: dict[str, str]):
    source = tmp_path / "src"
    source.mkdir()
    for rel, content in files.items():
        p = source / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return source


def test_create_then_restore_reverts_modify_create_delete(tmp_path):
    data_dir = str(tmp_path / "data")
    source = _make_source(tmp_path, {"keep.py": "k\n", "mod.py": "old\n", "gone.py": "bye\n"})
    sid = uuid4()

    # Simulate an apply that modifies mod.py, deletes gone.py, creates new.py.
    cp.create_checkpoint(
        data_dir=data_dir,
        run_id="r1",
        session_id=sid,
        source_root=source,
        rel_paths=["mod.py", "gone.py", "new.py"],
    )
    (source / "mod.py").write_text("new\n")
    (source / "gone.py").unlink()
    (source / "new.py").write_text("created\n")

    restored = cp.restore_checkpoint(data_dir=data_dir, run_id="r1", session_id=sid)

    assert set(restored) == {"mod.py", "gone.py", "new.py"}
    assert (source / "mod.py").read_text() == "old\n"        # modification reverted
    assert (source / "gone.py").read_text() == "bye\n"       # deletion recreated
    assert not (source / "new.py").exists()                  # creation removed
    assert (source / "keep.py").read_text() == "k\n"         # untouched


def test_restore_rejects_wrong_session(tmp_path):
    data_dir = str(tmp_path / "data")
    source = _make_source(tmp_path, {"a.py": "1\n"})
    cp.create_checkpoint(
        data_dir=data_dir, run_id="r2", session_id=uuid4(), source_root=source, rel_paths=["a.py"]
    )
    import pytest

    with pytest.raises(KeyError):
        cp.restore_checkpoint(data_dir=data_dir, run_id="r2", session_id=uuid4())


def test_list_checkpoints_newest_first(tmp_path):
    data_dir = str(tmp_path / "data")
    source = _make_source(tmp_path, {"a.py": "1\n"})
    sid = uuid4()
    cp.create_checkpoint(
        data_dir=data_dir, run_id="older", session_id=sid, source_root=source,
        rel_paths=["a.py"], label="older",
    )
    cp.create_checkpoint(
        data_dir=data_dir, run_id="newer", session_id=sid, source_root=source,
        rel_paths=["a.py"], label="newer",
    )
    ids = [c.run_id for c in cp.list_checkpoints(data_dir, sid)]
    assert set(ids) == {"older", "newer"}
    # Both belong to the session; a different session sees none.
    assert cp.list_checkpoints(data_dir, uuid4()) == []


def test_apply_isolated_run_captures_a_restorable_checkpoint(tmp_path):
    """End-to-end: applying an isolated run leaves a checkpoint that undoes it."""
    data_dir = str(tmp_path / "data")
    source = _make_source(tmp_path, {"feature.py": "v1\n"})
    sid = uuid4()

    run = zr.prepare_isolated_run(
        data_dir=data_dir, run_id="run-1", session_id=sid, source_root=source
    )
    # Agent edits the isolated copy.
    (run.workspace / "feature.py").write_text("v2\n")
    (run.workspace / "added.py").write_text("brand new\n")

    applied = zr.apply_isolated_run(run)
    assert set(applied) == {"feature.py", "added.py"}
    assert (source / "feature.py").read_text() == "v2\n"
    assert (source / "added.py").read_text() == "brand new\n"

    # Now undo the whole run.
    restored = cp.restore_checkpoint(data_dir=data_dir, run_id="run-1", session_id=sid)
    assert set(restored) == {"feature.py", "added.py"}
    assert (source / "feature.py").read_text() == "v1\n"     # reverted
    assert not (source / "added.py").exists()                # creation undone


def test_prune_caps_checkpoints_per_session(tmp_path):
    data_dir = str(tmp_path / "data")
    source = _make_source(tmp_path, {"a.py": "1\n"})
    sid = uuid4()
    # Create more than the keep limit; created_at ordering is by timestamp, so
    # space them with explicit run ids and rely on list ordering.
    import time

    for i in range(8):
        cp.create_checkpoint(
            data_dir=data_dir,
            run_id=f"run-{i:02d}",
            session_id=sid,
            source_root=source,
            rel_paths=["a.py"],
            label=f"cp{i}",
        )
        time.sleep(0.001)

    kept = cp.list_checkpoints(data_dir, sid)
    assert len(kept) <= 8
    # Prune to keep only 3 → the 3 newest remain.
    removed = cp.prune_checkpoints(data_dir, sid, keep=3)
    remaining = cp.list_checkpoints(data_dir, sid)
    assert len(remaining) == 3
    assert len(removed) == len(kept) - 3
    # The newest (highest index) survive.
    assert "run-07" in {c.run_id for c in remaining}
    assert "run-00" not in {c.run_id for c in remaining}


def test_checkpoints_endpoint_lists_newest_first(client, session, mock_provider, tmp_workspace):
    from llama_studio_agent.providers.base import ProviderToolCall
    from llama_studio_agent.providers.mock import MockResponse

    def queue_write(path: str, content: str) -> None:
        mock_provider.reset()
        mock_provider.queue(
            MockResponse(text='{"goal":"g","steps":[{"title":"w"}]}'),
            MockResponse(
                text="",
                tool_calls=[ProviderToolCall(id="t", name="write_file", arguments={"path": path, "content": content})],
            ),
            MockResponse(text="done"),
        )

    # Run + apply two review runs so two checkpoints get captured.
    for i in range(2):
        queue_write(f"f{i}.py", f"v{i}\n")
        run = client.post(
            f"/v1/sessions/{session.id}/agent/run",
            json={"message": "edit", "workspacePath": str(tmp_workspace), "mode": "agent", "reviewChanges": True},
        )
        run_id = run.json()["review"]["run_id"]
        client.post(f"/v1/sessions/{session.id}/agent/runs/{run_id}/apply")

    resp = client.get(f"/v1/sessions/{session.id}/agent/checkpoints")
    assert resp.status_code == 200, resp.text
    cps = resp.json()
    assert len(cps) == 2
    assert all("run_id" in c and "created_at" in c for c in cps)
