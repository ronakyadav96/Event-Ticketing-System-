"""HTTP-level tests: identity, conversation ownership and the response contract."""

import pytest
from fastapi.testclient import TestClient

from tests.conftest import make_token


@pytest.fixture
def client(fake_node, model):
    from app.main import app

    with TestClient(app) as c:
        yield c


def auth(user_id):
    return {"Authorization": f"Bearer {make_token(user_id)}"}


GUEST = {"X-Guest-Id": "0123456789abcdef0123"}


def test_requires_identity(client):
    r = client.post("/api/v1/chat", json={"message": "hi", "conversation_id": "conv_abcdefgh"})
    assert r.status_code == 400


def test_rejects_forged_token(client):
    forged = make_token("victim")[:-4] + "AAAA"
    r = client.get("/api/v1/conversations", headers={"Authorization": f"Bearer {forged}"})
    assert r.status_code == 401


def test_user_cannot_read_or_post_to_another_users_conversation(client, model):
    model.on("hello", intent="SMALL_TALK")
    conv = client.post("/api/v1/conversations", headers=auth("alice")).json()["conversation_id"]
    assert client.post("/api/v1/chat", headers=auth("alice"), json={"message": "hello", "conversation_id": conv}).status_code == 200

    assert client.get(f"/api/v1/conversations/{conv}/messages", headers=auth("bob")).status_code == 404
    assert client.post("/api/v1/chat", headers=auth("bob"), json={"message": "hello", "conversation_id": conv}).status_code == 404
    assert client.delete(f"/api/v1/conversations/{conv}", headers=auth("bob")).status_code == 404
    assert client.get(f"/api/v1/conversations/{conv}/messages", headers=GUEST).status_code == 404

    listed = client.get("/api/v1/conversations", headers=auth("bob")).json()["conversations"]
    assert conv not in [c["id"] for c in listed]
    mine = client.get(f"/api/v1/conversations/{conv}/messages", headers=auth("alice")).json()
    assert [m["role"] for m in mine["messages"]] == ["user", "assistant"]


def test_client_cannot_inject_booking_state(client, model):
    model.on("yes", intent="BOOKING", confirmation=True)
    r = client.post(
        "/api/v1/chat",
        headers=auth("carol"),
        json={"message": "yes", "conversation_id": "conv_injected1", "booking_step": "REVIEW",
              "selected_event": {"_id": "e_music"}, "booking_details": {"status": "PAID"}},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["booking"]["stage"] == "IDLE"
    assert body["booking"]["payment"] is None and body["booking"]["ticket"] is None


def test_payment_url_only_with_open_checkout(client, model, fake_node):
    h = auth("dave")
    conv = "conv_paymentflow"
    steps = [
        ("comedy", {"intent": "EVENT_SEARCH", "search": {"category": "Comedy"}}),
        ("book it", {"intent": "BOOKING", "event_id": "e_comedy2"}),
        ("1", {"intent": "BOOKING", "quantity": 1}),
        ("B5", {"intent": "BOOKING", "seats": ["B5"]}),
    ]
    for msg, fields in steps:
        model.on(msg, **fields)
        body = client.post("/api/v1/chat", headers=h, json={"message": msg, "conversation_id": conv}).json()
        assert body["booking"]["payment"] is None
    assert body["booking"]["stage"] == "REVIEW"
    assert body["booking"]["total_price"] == 400

    model.on("confirm", intent="BOOKING", confirmation=True)
    body = client.post("/api/v1/chat", headers=h, json={"message": "confirm", "conversation_id": conv}).json()
    assert body["booking"]["stage"] == "PAYMENT_PENDING"
    assert body["booking"]["payment"]["payment_url"].startswith("https://checkout.stripe.com/")
    assert body["booking"]["ticket"] is None

    fake_node.mark_paid(body["booking"]["payment"]["session_id"])
    state = client.get(f"/api/v1/conversations/{conv}/state", headers=h).json()
    assert state["booking"]["stage"] == "COMPLETED"
    assert state["booking"]["ticket"]["ticket_id"] == "TKT-PAID-0001"
    assert state["booking"]["payment"]["payment_url"] is None
