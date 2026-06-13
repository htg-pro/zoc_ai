from shared_schema.models import PermissionScope, RunAgentRequest


def test_create_and_get_session(client, tmp_workspace):
    resp = client.post(
        "/v1/sessions",
        json={"title": "t", "workspace_root": str(tmp_workspace), "provider": "mock", "model": "mock-1"},
    )
    assert resp.status_code == 201
    sid = resp.json()["id"]
    assert client.get(f"/v1/sessions/{sid}").status_code == 200
    assert client.get("/v1/sessions").json()


def test_delete_session(client, session):
    r = client.delete(f"/v1/sessions/{session.id}")
    assert r.status_code == 204
    assert client.get(f"/v1/sessions/{session.id}").status_code == 404
    assert all(row["id"] != str(session.id) for row in client.get("/v1/sessions").json())


def test_post_message(client, session):
    r = client.post(
        f"/v1/sessions/{session.id}/messages",
        json={"role": "user", "content": "hi"},
    )
    assert r.status_code == 201
    assert client.get(f"/v1/sessions/{session.id}/messages").json()[0]["content"] == "hi"


def test_permissions_round_trip(client, session):
    r = client.post(
        f"/v1/sessions/{session.id}/permissions",
        json=[{"scope": PermissionScope.network.value, "granted": True, "note": "ok"}],
    )
    assert r.status_code == 200
    scopes = {g["scope"] for g in r.json() if g["granted"]}
    assert PermissionScope.network.value in scopes


def test_tool_grants_round_trip(client, session):
    # Initially there are no per-tool grants.
    assert client.get(f"/v1/sessions/{session.id}/tool-grants").json() == []

    # Post a one-shot grant for run_command.
    r = client.post(
        f"/v1/sessions/{session.id}/tool-grants",
        json=[{"tool": "run_command", "granted": True, "once": True, "note": "from prompt"}],
    )
    assert r.status_code == 200
    granted = {g["tool"]: g for g in r.json() if g["granted"]}
    assert "run_command" in granted
    assert granted["run_command"]["once"] is True

    # It is listed by the GET route too.
    listed = client.get(f"/v1/sessions/{session.id}/tool-grants").json()
    assert any(g["tool"] == "run_command" and g["granted"] for g in listed)

    # Revoking removes it entirely.
    r2 = client.post(
        f"/v1/sessions/{session.id}/tool-grants",
        json=[{"tool": "run_command", "granted": False}],
    )
    assert r2.status_code == 200
    assert all(g["tool"] != "run_command" for g in r2.json())
    assert client.get(f"/v1/sessions/{session.id}/tool-grants").json() == []


def test_tools_list_includes_eight(client):
    names = {t["name"] for t in client.get("/v1/tools").json()}
    assert {
        "read_file", "write_file", "list_dir", "apply_patch",
        "search", "run_command", "ast_query", "index_query",
    } <= names


def test_providers_listed(client):
    kinds = {p["kind"] for p in client.get("/v1/providers").json()}
    assert "mock" in kinds and "openai" in kinds


def test_commands_listed(client):
    names = {c["name"] for c in client.get("/v1/commands").json()}
    assert names == {"review", "test", "explain", "fix", "refactor", "docs", "grok"}


def test_invoke_read_file_tool(client, session):
    r = client.post(
        f"/v1/tools/{session.id}/read_file/invoke",
        json={"arguments": {"path": "src/hello.py"}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] and "greet" in body["data"]["content"]


def test_run_agent(client, session, mock_provider):
    mock_provider.queue(
        # planner
        type("R", (), {"text": '{"goal":"g","steps":[{"title":"a"}]}', "tool_calls": []})(),
    )
    # The mock_provider fixture replaces script via .queue; need MockResponse.
    from llama_studio_agent.providers.mock import MockResponse
    mock_provider.reset()
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"a"}]}'),
        MockResponse(text="hello"),
    )
    r = client.post(
        f"/v1/sessions/{session.id}/agent/run", json={"prompt": "hi", "max_repair_attempts": 0}
    )
    assert r.status_code == 200, r.text
    assert r.json()["final_text"] == "hello"


def test_run_agent_request_accepts_iteration_budget_aliases():
    camel = RunAgentRequest.model_validate({"message": "hi", "maxIterations": 20})
    snake = RunAgentRequest.model_validate({"message": "hi", "max_iterations": 18})

    assert camel.max_iterations == 20
    assert snake.max_iterations == 18


def test_run_agent_analyze_project_receives_workspace_snapshot(client, session, mock_provider, tmp_workspace):
    from llama_studio_agent.providers.mock import MockResponse

    (tmp_workspace / "package.json").write_text(
        '{"scripts":{"dev":"vite","test":"vitest"},"dependencies":{"react":"latest","vite":"latest"}}',
        encoding="utf-8",
    )
    mock_provider.queue(
        MockResponse(text='{"goal":"Analyze project","steps":[{"title":"inspect"}]}'),
        MockResponse(text="This is a Vite/React project."),
    )

    r = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={
            "message": "analyze this project",
            "workspacePath": str(tmp_workspace),
            "openFiles": [],
            "maxRepairAttempts": 0,
        },
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["final_text"] == "This is a Vite/React project."
    assert any(call["name"] == "get_project_summary" for call in body["tool_calls"])
    main_request = mock_provider.requests[-1]
    system_text = "\n\n".join(m.content for m in main_request.messages if m.role == "system")
    assert "Current workspace project snapshot" in system_text
    assert "workspace_root" in system_text and str(tmp_workspace) in system_text
    assert "src (dir)" in system_text
    assert "README.md (file)" in system_text
    assert "package.json" in system_text
    assert "do not ask the user to upload or paste files" in system_text.lower()


def test_run_slash_command(client, session, mock_provider):
    from llama_studio_agent.providers.mock import MockResponse
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"a"}]}'),
        MockResponse(text="explained."),
    )
    r = client.post(
        f"/v1/commands/{session.id}/run",
        json={"name": "explain", "args": {"target": "src/hello.py"}},
    )
    assert r.status_code == 200
    assert "final_text" in r.json()
