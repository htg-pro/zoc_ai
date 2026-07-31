"""Durable Sessions and transcripts — zoc-agent-chat-rebuild R15.2, R15.6, R15.11, R23.5.

Before this store existed, ``SessionRegistry`` was a dict and there was no
transcript store at all: a Session and its messages died with the process, and the
Agent_Runtime's ``loadHistory`` port had nothing to read, so every Run was
single-turn. These tests pin the four claims that make the replacement worth
having.

1. **A transcript round-trips verbatim.** The stored record is an AI SDK
   ``UIMessage`` whose part union the gateway deliberately does not model, so
   "verbatim" is the contract — a field the store does not understand must come
   back byte-identical or the Chat_Surface loses a row on restore.
2. **A restart keeps it.** Asserted by building a *second* registry over the same
   root, which is what a relaunch is.
3. **Writing one Session does not touch another** (R23.5), asserted on bytes
   rather than on parsed equality.
4. **Archive reaches disk** (R15.11). An archive that survives only in memory
   un-archives itself on the next launch.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from shared_schema.models import CreateSessionRequest, Session, UpdateSessionRequest
from zocai_gateway.app import SessionRegistry, create_app
from zocai_gateway.transcripts import TranscriptRecordError, TranscriptStore
from zocai_gateway.workspace_binder import WorkspaceBinder


@pytest.fixture
def store(tmp_path: Path) -> TranscriptStore:
    return TranscriptStore(tmp_path / "sessions")


def ui_message(identifier: str, role: str = "assistant", **extra: object) -> dict[str, object]:
    """A message shaped the way the Chat_Surface actually stores one."""
    return {
        "id": identifier,
        "role": role,
        "metadata": {
            "runId": "run_1",
            "provider": "anthropic",
            "model": "claude-sonnet-5",
            "conversationMode": "agent",
            "tokensPerSecond": 41.5,
            "rulesSources": [".zoc/rules"],
        },
        "parts": [
            {"type": "step-start"},
            {"type": "text", "text": "Here is the change."},
            {
                "type": "data-zoc-diff",
                "id": "diff_1",
                "data": {
                    "type": "diff",
                    "seq": 7,
                    "runId": "run_1",
                    "messageId": identifier,
                    "checkpointId": "chk_42",
                    "hunks": [{"action": "modify", "path": "src/a.ts"}],
                },
            },
        ],
        **extra,
    }


# ── The store ─────────────────────────────────────────────────────────────


def test_a_transcript_round_trips_verbatim(store: TranscriptStore) -> None:
    original = [ui_message("m1", "user"), ui_message("m2")]

    store.replace_messages("s1", original)
    restored = store.list_messages("s1")

    # Field-for-field, including the nested `data-zoc-*` payloads and the
    # `checkpointId` R10.5's references travel on. The store understands none of
    # them, which is exactly why this has to be asserted rather than assumed.
    assert [dict(record) for record in restored] == [
        {**message, "createdAt": restored[index]["createdAt"]}
        for index, message in enumerate(original)
    ]
    assert restored[1]["parts"][2]["data"]["checkpointId"] == "chk_42"


def test_an_unknown_field_survives_the_round_trip(store: TranscriptStore) -> None:
    store.replace_messages("s1", [ui_message("m1", "assistant", somethingNew={"a": [1, 2]})])
    assert store.list_messages("s1")[0]["somethingNew"] == {"a": [1, 2]}


def test_created_at_is_stamped_once_and_then_kept(store: TranscriptStore) -> None:
    first = store.replace_messages("s1", [ui_message("m1")])
    stamped = first[0]["createdAt"]
    assert isinstance(stamped, str)

    # A replace must not re-date the transcript, or R15.3's last-activity figure
    # would follow every rewrite instead of the conversation.
    again = store.replace_messages("s1", first)
    assert again[0]["createdAt"] == stamped


def test_replace_does_not_double_the_history(store: TranscriptStore) -> None:
    # `onFinish` hands over the complete conversation every time, which is why the
    # runtime's write is a replace rather than an append.
    store.replace_messages("s1", [ui_message("m1", "user")])
    store.replace_messages("s1", [ui_message("m1", "user"), ui_message("m2")])

    assert [record["id"] for record in store.list_messages("s1")] == ["m1", "m2"]


def test_append_replaces_a_record_with_the_same_id(store: TranscriptStore) -> None:
    # The renderer writes the user turn on submit; the runtime rewrites the same
    # turn on finish. Two rows for one message renders the prompt twice.
    store.append_message("s1", ui_message("m1", "user"))
    store.append_message(
        "s1", {**ui_message("m1", "user"), "parts": [{"type": "text", "text": "edited"}]}
    )

    records = store.list_messages("s1")
    assert len(records) == 1
    assert records[0]["parts"] == [{"type": "text", "text": "edited"}]


def test_append_keeps_transcript_order(store: TranscriptStore) -> None:
    for index in range(4):
        store.append_message(
            "s1", ui_message(f"m{index}", "user" if index % 2 == 0 else "assistant")
        )
    assert [record["id"] for record in store.list_messages("s1")] == ["m0", "m1", "m2", "m3"]


def test_a_message_without_an_id_or_role_is_refused(store: TranscriptStore) -> None:
    # Refused rather than coerced: a message with no id cannot be reconciled on
    # restore, and one with an unknown role cannot be rendered.
    with pytest.raises(TranscriptRecordError):
        store.replace_messages("s1", [{"role": "user", "parts": []}])
    with pytest.raises(TranscriptRecordError):
        store.replace_messages("s1", [{"id": "m1", "role": "narrator", "parts": []}])
    with pytest.raises(TranscriptRecordError):
        store.replace_messages("s1", [{"id": "m1", "role": "user", "parts": "text"}])


def test_one_unreadable_record_costs_that_record_only(store: TranscriptStore) -> None:
    store.replace_messages("s1", [ui_message("m1", "user"), ui_message("m2")])
    path = store.root / "s1" / "messages.json"
    records = json.loads(path.read_text(encoding="utf-8"))
    records.insert(1, {"role": "assistant", "parts": []})  # no id
    path.write_text(json.dumps(records), encoding="utf-8")

    assert [record["id"] for record in store.list_messages("s1")] == ["m1", "m2"]


def test_an_unreadable_transcript_file_reads_as_empty(store: TranscriptStore) -> None:
    store.replace_messages("s1", [ui_message("m1")])
    (store.root / "s1" / "messages.json").write_text("{ not json", encoding="utf-8")
    assert store.list_messages("s1") == []


def test_a_session_id_cannot_climb_out_of_the_store(store: TranscriptStore) -> None:
    # The id arrives as a URL path parameter. Refused rather than sanitised.
    for unusable in ["..", "../escape", "a/b", "", "."]:
        with pytest.raises(TranscriptRecordError):
            store.replace_messages(unusable, [])


def test_writing_one_session_leaves_another_byte_identical(store: TranscriptStore) -> None:
    store.replace_messages("s1", [ui_message("m1")])
    path = store.root / "s1" / "messages.json"
    before = path.read_bytes()

    store.replace_messages("s2", [ui_message("m2"), ui_message("m3")])
    store.append_message("s2", ui_message("m4"))

    # R23.5, asserted on bytes: per-Session files make this true by construction
    # rather than by careful merging.
    assert path.read_bytes() == before


def test_message_text_is_what_a_search_should_match(store: TranscriptStore) -> None:
    store.replace_messages("s1", [ui_message("m1", "user")])
    texts = store.message_text("s1")

    # Text parts only. Matching serialised tool payloads would hit JSON keys and
    # paths the user never wrote.
    assert texts == ["Here is the change."]
    assert not any("data-zoc-diff" in text for text in texts)


# ── The registry, across a restart ────────────────────────────────────────


def registry_with_session(store: TranscriptStore, root: Path) -> tuple[SessionRegistry, Session]:
    registry = SessionRegistry(store=store)
    binder = WorkspaceBinder(override=root)
    session = registry.create(
        CreateSessionRequest(title="Refactor the parser", workspace_root=str(root)),
        binder=binder,
    )
    return registry, session


def test_a_session_survives_a_restart(store: TranscriptStore, tmp_path: Path) -> None:
    _, session = registry_with_session(store, tmp_path)
    store.replace_messages(str(session.id), [ui_message("m1", "user")])

    # A second registry over the same root is what a relaunch is.
    restarted = SessionRegistry(store=TranscriptStore(store.root))

    reloaded = restarted.get(str(session.id))
    assert reloaded is not None
    assert reloaded.title == "Refactor the parser"
    assert reloaded.workspace_root == session.workspace_root
    assert [record["id"] for record in restarted.store.list_messages(str(session.id))] == ["m1"]


def test_the_metadata_row_never_carries_the_transcript(
    store: TranscriptStore, tmp_path: Path
) -> None:
    _, session = registry_with_session(store, tmp_path)
    store.replace_messages(str(session.id), [ui_message("m1")])

    payload = json.loads((store.root / str(session.id) / "session.json").read_text("utf-8"))

    # R2.4: part data stays out of the metadata row, so `messages.json` is the one
    # source of truth for the transcript.
    assert payload["messages"] == []


def test_archiving_reaches_disk_and_keeps_the_transcript(
    store: TranscriptStore, tmp_path: Path
) -> None:
    registry, session = registry_with_session(store, tmp_path)
    store.replace_messages(str(session.id), [ui_message("m1", "user"), ui_message("m2")])
    before = (store.root / str(session.id) / "messages.json").read_bytes()

    updated = registry.update(str(session.id), UpdateSessionRequest(status="closed"))
    assert updated is not None
    assert updated.status.value == "closed"

    restarted = SessionRegistry(store=TranscriptStore(store.root))
    reloaded = restarted.get(str(session.id))
    assert reloaded is not None
    assert reloaded.status.value == "closed"
    # Archive is a status change, not a truncation.
    assert (store.root / str(session.id) / "messages.json").read_bytes() == before


def test_a_rename_persists_without_touching_the_transcript(
    store: TranscriptStore, tmp_path: Path
) -> None:
    registry, session = registry_with_session(store, tmp_path)
    store.replace_messages(str(session.id), [ui_message("m1")])
    before = (store.root / str(session.id) / "messages.json").read_bytes()

    registry.update(str(session.id), UpdateSessionRequest(title="Renamed"))

    restarted = SessionRegistry(store=TranscriptStore(store.root))
    assert restarted.get(str(session.id)) is not None
    assert restarted.get(str(session.id)).title == "Renamed"  # type: ignore[union-attr]
    assert (store.root / str(session.id) / "messages.json").read_bytes() == before


def test_delete_removes_the_session_and_its_transcript(
    store: TranscriptStore, tmp_path: Path
) -> None:
    registry, session = registry_with_session(store, tmp_path)
    store.replace_messages(str(session.id), [ui_message("m1")])

    assert registry.delete(str(session.id)) is True
    assert not (store.root / str(session.id)).exists()
    assert SessionRegistry(store=TranscriptStore(store.root)).list() == []
    # Deleting twice is not an error the second time, it is a 404 the route raises.
    assert registry.delete(str(session.id)) is False


# ── The routes ────────────────────────────────────────────────────────────


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    return TestClient(
        create_app(workspace_root=tmp_path, transcripts=TranscriptStore(tmp_path / "store"))
    )


def create_session(client: TestClient) -> str:
    response = client.post(
        "/v1/sessions", json={"title": "Session", "workspace_root": "/ignored-advisory"}
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def test_the_three_message_routes_are_registered(tmp_path: Path) -> None:
    app = create_app(transcripts=TranscriptStore(tmp_path / "store"))
    paths = {route.path for route in app.routes}  # type: ignore[attr-defined]
    assert "/v1/sessions/{session_id}/messages" in paths


def test_put_then_get_restores_the_transcript(client: TestClient) -> None:
    session_id = create_session(client)
    messages = [ui_message("m1", "user"), ui_message("m2")]

    put = client.put(f"/v1/sessions/{session_id}/messages", json={"messages": messages})
    assert put.status_code == 200, put.text

    got = client.get(f"/v1/sessions/{session_id}/messages")
    assert got.status_code == 200
    restored = got.json()["messages"]
    assert [record["id"] for record in restored] == ["m1", "m2"]
    assert restored[1]["parts"][2]["data"]["checkpointId"] == "chk_42"


def test_post_appends_one_message(client: TestClient) -> None:
    session_id = create_session(client)

    response = client.post(
        f"/v1/sessions/{session_id}/messages", json={"message": ui_message("m1", "user")}
    )

    assert response.status_code == 201, response.text
    assert [record["id"] for record in response.json()["messages"]] == ["m1"]


def test_an_unknown_session_is_a_404_on_all_three(client: TestClient) -> None:
    missing = "00000000-0000-4000-8000-000000000000"
    assert client.get(f"/v1/sessions/{missing}/messages").status_code == 404
    assert client.put(f"/v1/sessions/{missing}/messages", json={"messages": []}).status_code == 404
    assert (
        client.post(
            f"/v1/sessions/{missing}/messages", json={"message": ui_message("m1")}
        ).status_code
        == 404
    )


def test_an_unusable_message_is_a_422_rather_than_a_partial_write(client: TestClient) -> None:
    session_id = create_session(client)
    client.put(f"/v1/sessions/{session_id}/messages", json={"messages": [ui_message("m1", "user")]})

    bad = client.put(
        f"/v1/sessions/{session_id}/messages",
        json={"messages": [ui_message("m2"), {"role": "assistant"}]},
    )

    assert bad.status_code == 422
    # The whole batch is validated before anything is written, so the previous
    # transcript is still there rather than half-replaced.
    kept = client.get(f"/v1/sessions/{session_id}/messages").json()["messages"]
    assert [record["id"] for record in kept] == ["m1"]


def test_an_archived_session_still_answers_its_transcript(client: TestClient) -> None:
    session_id = create_session(client)
    client.put(f"/v1/sessions/{session_id}/messages", json={"messages": [ui_message("m1", "user")]})

    archived = client.patch(f"/v1/sessions/{session_id}", json={"status": "closed"})
    assert archived.status_code == 200
    assert archived.json()["status"] == "closed"

    # R15.11: archiving retains the transcript, and an archived filter reaches it.
    restored = client.get(f"/v1/sessions/{session_id}/messages").json()["messages"]
    assert [record["id"] for record in restored] == ["m1"]
