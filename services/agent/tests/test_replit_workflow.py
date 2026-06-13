import asyncio
import json
from pathlib import Path

from llama_studio_agent.agent.replit_workflow import (
    ReplitWorkflowService,
    discover_validation_commands,
)
from shared_schema.models import ReplitTaskStatus


def test_replit_ready_requires_real_validation_artifacts(client, session):
    plan = client.post(
        f"/v1/sessions/{session.id}/replit/plans",
        json={"prompt": "Add workflow validation"},
    )
    assert plan.status_code == 200, plan.text
    task = plan.json()["tasks"][0]

    ready = client.post(f"/v1/sessions/{session.id}/replit/tasks/{task['id']}/ready")
    assert ready.status_code == 409
    assert "clean validation" in ready.text

    queued = client.post(f"/v1/sessions/{session.id}/replit/tasks/{task['id']}/queue")
    assert queued.status_code == 200
    assert queued.json()["status"] == "queued"


def test_replit_plan_for_website_request_creates_product_tasks(client, session):
    plan = client.post(
        f"/v1/sessions/{session.id}/replit/plans",
        json={"prompt": "Build a demo portfolio website for a designer"},
    )

    assert plan.status_code == 200, plan.text
    tasks = plan.json()["tasks"]
    titles = [task["title"] for task in tasks]
    likely_files = {file for task in tasks for file in task["files_likely_changed"]}

    assert titles == ["Build and validate the portfolio website"]
    assert "src/App.tsx" in likely_files
    assert "README.md" in likely_files
    assert "apps/frontend/src/lib/store.ts" not in likely_files


def test_replit_apply_requires_ready_and_creates_checkpoint(client, session, app_state):
    task = client.post(
        f"/v1/sessions/{session.id}/replit/tasks",
        json={
            "title": "Change README",
            "summary": "Update docs",
            "priority": "medium",
            "files_likely_changed": ["README.md"],
            "done_looks_like": ["README updated"],
            "test_plan": ["NO ERROR validation"],
        },
    ).json()
    task_id = task["id"]

    blocked = client.post(f"/v1/sessions/{session.id}/replit/tasks/{task_id}/apply")
    assert blocked.status_code == 409

    workspace = Path(session.workspace_root) / ".llama-studio-agent" / "tasks" / task_id / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "src").mkdir()
    (workspace / "src" / "hello.py").write_text(
        (Path(session.workspace_root) / "src" / "hello.py").read_text("utf-8"),
        encoding="utf-8",
    )
    (workspace / "README.md").write_text("# changed\n", encoding="utf-8")
    model = app_state.repo.get_replit_task(session.id, task_id)
    model.status = ReplitTaskStatus.active
    model.workspace_path = str(workspace)
    model.diff = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# fixture repo\n+# changed"
    model.test_output = "NO ERROR\n[PASS] Python compile"
    app_state.repo.save_replit_task(model)

    ready = client.post(f"/v1/sessions/{session.id}/replit/tasks/{task_id}/ready")
    assert ready.status_code == 200, ready.text
    assert ready.json()["status"] == "ready"

    applied = client.post(f"/v1/sessions/{session.id}/replit/tasks/{task_id}/apply")
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "done"
    assert (Path(session.workspace_root) / "README.md").read_text("utf-8") == "# changed\n"

    checkpoints = client.get(f"/v1/sessions/{session.id}/replit/checkpoints").json()
    assert checkpoints
    assert checkpoints[0]["files"] == ["README.md"]


def test_discover_validation_commands_detects_monorepo(tmp_path):
    (tmp_path / "pnpm-workspace.yaml").write_text(
        "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
        encoding="utf-8",
    )
    (tmp_path / "package.json").write_text('{"name":"root"}', encoding="utf-8")
    (tmp_path / "pnpm-lock.yaml").write_text("", encoding="utf-8")
    pkg = tmp_path / "apps" / "frontend"
    pkg.mkdir(parents=True)
    pkg.joinpath("package.json").write_text(
        json.dumps({"name": "@llama-studio/frontend", "scripts": {"typecheck": "tsc", "test": "vitest", "build": "vite build"}}),
        encoding="utf-8",
    )

    cmds = discover_validation_commands(tmp_path)
    rendered = {" ".join(c.cmd) for c in cmds}
    assert "pnpm --filter @llama-studio/frontend typecheck" in rendered
    assert "pnpm --filter @llama-studio/frontend test" in rendered
    assert "pnpm --filter @llama-studio/frontend build" in rendered


def test_discover_validation_commands_includes_ruff_when_configured(tmp_path):
    (tmp_path / "pyproject.toml").write_text(
        "[tool.ruff]\nline-length = 100\n",
        encoding="utf-8",
    )
    cmds = discover_validation_commands(tmp_path)
    labels = {c.label for c in cmds}
    assert "Ruff lint" in labels


def test_invalid_transitions_return_409(client, session, app_state):
    task = client.post(
        f"/v1/sessions/{session.id}/replit/tasks",
        json={"title": "x", "summary": "y", "priority": "low"},
    ).json()
    task_id = task["id"]

    # draft -> apply is invalid; surface as 409
    r = client.post(f"/v1/sessions/{session.id}/replit/tasks/{task_id}/apply")
    assert r.status_code == 409

    # Mark task done directly in the DB, then verify done -> start is rejected.
    model = app_state.repo.get_replit_task(session.id, task_id)
    model.status = ReplitTaskStatus.done
    app_state.repo.save_replit_task(model)
    r = client.post(f"/v1/sessions/{session.id}/replit/tasks/{task_id}/start")
    assert r.status_code == 409

    # dismissed -> queue is also invalid
    model = app_state.repo.get_replit_task(session.id, task_id)
    model.status = ReplitTaskStatus.dismissed
    app_state.repo.save_replit_task(model)
    r = client.post(f"/v1/sessions/{session.id}/replit/tasks/{task_id}/queue")
    assert r.status_code == 409


def test_revise_plan_archives_previous(client, session):
    first = client.post(
        f"/v1/sessions/{session.id}/replit/plans",
        json={"prompt": "Initial plan"},
    ).json()
    revised = client.post(
        f"/v1/sessions/{session.id}/replit/plans/{first['id']}/revise",
        json={"prompt": "Better plan"},
    )
    assert revised.status_code == 200, revised.text
    revised_plan = revised.json()
    assert revised_plan["id"] != first["id"]

    plans = {p["id"]: p for p in client.get(f"/v1/sessions/{session.id}/replit/plans").json()}
    assert plans[first["id"]]["status"] == "archived"
    assert plans[revised_plan["id"]]["status"] == "draft"


def test_validation_attempts_persists_when_no_diff(app_state, session):
    """No diff path still bumps validation_attempts? Actually the no-diff path
    short-circuits before incrementing. Force a real diff and verify the
    attempt counter persists across reloads."""

    workflow = ReplitWorkflowService(app_state)
    task = workflow.create_task(
        session_id=session.id,
        task=__import__("shared_schema.models", fromlist=["ReplitTask"]).ReplitTask(
            session_id=session.id,
            title="instrumentation",
            summary="verify validation_attempts",
        ),
    )

    workspace = Path(session.workspace_root) / ".llama-studio-agent" / "tasks" / str(task.id) / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "README.md").write_text("# diff present\n", encoding="utf-8")
    task.workspace_path = str(workspace)
    task.status = ReplitTaskStatus.active
    app_state.repo.save_replit_task(task)

    asyncio.run(workflow._validate_repair_loop(session_id=session.id, task=task, workspace=workspace))

    reloaded = app_state.repo.get_replit_task(session.id, task.id)
    assert reloaded is not None
    assert reloaded.validation_attempts >= 1
