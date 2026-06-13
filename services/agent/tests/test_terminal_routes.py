"""End-to-end tests for the terminal HTTP surface.

We spawn a real `/bin/cat` (echoes stdin → stdout), then exercise the
`input`, `resize`, and `stream` routes. `cat` keeps the PTY open and
flushes every line, which makes the SSE assertion deterministic.
"""

from __future__ import annotations

import json
import os
import time

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX-only PTY")


def _spawn_echo(client) -> str:
    # One-shot shell: read a line, echo it, exit. This ensures the SSE
    # stream terminates without us having to poll on a never-exiting process.
    r = client.post(
        "/v1/terminal",
        json={
            "cmd": "/bin/sh",
            "args": ["-c", "read line; echo \"$line\"; exit 0"],
            "cols": 80,
            "rows": 24,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_terminal_list_empty(client):
    assert client.get("/v1/terminal").json() == []


def test_terminal_spawn_input_resize_stop(client):
    sid = _spawn_echo(client)

    assert client.post(f"/v1/terminal/{sid}/resize", json={"cols": 100, "rows": 40}).json() == {
        "ok": True,
    }
    assert client.post(f"/v1/terminal/{sid}/input", json={"data": "hello\n"}).json() == {
        "ok": True,
    }

    # Give cat a moment to echo the line back through the PTY.
    deadline = time.monotonic() + 2.0
    saw_hello = False
    with client.stream("GET", f"/v1/terminal/{sid}/stream") as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if time.monotonic() > deadline:
                break
            if not line or not line.startswith("data:"):
                continue
            payload = json.loads(line[5:].strip())
            if payload.get("type") == "data" and "hello" in payload.get("chunk", ""):
                saw_hello = True
                break

    assert saw_hello, "expected cat to echo 'hello' back via SSE"

    r = client.post(f"/v1/terminal/{sid}/stop")
    assert r.status_code == 200
    assert r.json()["status"] == "exited"


def test_terminal_unknown_id_404(client):
    fake = "00000000-0000-0000-0000-000000000000"
    assert client.post(f"/v1/terminal/{fake}/input", json={"data": "x"}).status_code == 404
    assert client.post(f"/v1/terminal/{fake}/resize", json={"cols": 80, "rows": 24}).status_code == 404
    assert client.post(f"/v1/terminal/{fake}/stop").status_code == 404
