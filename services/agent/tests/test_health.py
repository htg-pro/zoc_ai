def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "version" in body


def test_v1_ping(client):
    resp = client.get("/v1/ping")
    assert resp.status_code == 200
    assert resp.json() == {"pong": "v1"}
