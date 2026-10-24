"""
Test harness: a fake Node backend (same contract as the real Express API) and scripted
Model 1 outputs, so the real graph, agents, state machine and API run end to end.
Model 2 is left unavailable, which also exercises the deterministic wording fallbacks.
"""

import base64
import hashlib
import hmac
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ.update(
    {
        "APP_ENV": "test",
        "POSTGRES_URL": "",
        "REDIS_URL": "",
        "JWT_SECRET": "test-secret",
        "LLM_PROVIDER": "anthropic",
        "CHAT_BOOKING_MODE": "chat",  # the step-by-step flow; app hand-off has its own tests
        "ANTHROPIC_API_KEY": "",
        "GEMINI_API_KEY": "",
        "GOOGLE_API_KEY": "",
        "USE_IN_MEMORY_FALLBACK": "true",
        "EMBEDDING_PROVIDER": "builtin",
    }
)

from app.agents import intent as intent_module  # noqa: E402
from app.agents.intent import Extraction  # noqa: E402
from app.graph import workflow  # noqa: E402
from services.node_client import NodeAPIError, node_client  # noqa: E402

JWT_SECRET = "test-secret"


def make_token(user_id: str) -> str:
    def b64(obj: Dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    head, body = b64({"alg": "HS256", "typ": "JWT"}), b64({"id": user_id, "role": "user"})
    sig = hmac.new(JWT_SECRET.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def _event(eid, title, category, venue, price, dates, times, desc="", total=20):
    return {
        "_id": eid, "title": title, "category": category, "venue": venue, "price": price,
        "startDate": f"{dates[0]}T00:00:00.000Z", "endDate": f"{dates[-1]}T00:00:00.000Z",
        "showTimes": times, "description": desc, "totalSeats": total, "bookedSeats": 0,
        "_dates": dates,
    }


class FakeNode:
    """In-memory stand-in for the Express backend, honouring the same rules."""

    def __init__(self):
        self.events = {
            e["_id"]: e
            for e in [
                _event("e_comedy1", "Laugh Riot", "Comedy", "Canvas Club", 300, ["2030-01-10", "2030-01-11"], ["19:00", "21:30"], "Stand-up night"),
                _event("e_comedy2", "Punchline Live", "Comedy", "Comedy Store", 400, ["2030-01-12"], ["20:00"]),
                _event("e_comedy3", "Giggle Fest", "Comedy", "Canvas Club", 250, ["2030-01-15"], ["18:00"]),
                *[_event(f"e_comedy_x{i}", f"Open Mic {i}", "Comedy", "Bar {i}", 150, ["2030-01-20"], ["20:00"]) for i in range(1, 9)],
                _event("e_scifi1", "Star Voyage", "Movie", "PVR Phoenix", 250, ["2030-01-10"], ["10:00", "19:45"], "A science fiction epic"),
                _event("e_scifi2", "Star Voyage", "Movie", "INOX Malad", 220, ["2030-01-10"], ["13:00"], "A science fiction epic"),
                _event("e_music", "Rock Night", "Concert", "Arena", 999, ["2030-02-01"], ["20:00"]),
            ]
        }
        self.booked: Dict[str, set] = {}
        self.orders: Dict[str, Dict[str, Any]] = {}
        self.bookings: Dict[str, Dict[str, Any]] = {}
        self.calls: List[str] = []
        self.checkout_error: Optional[NodeAPIError] = None
        self.checkout_url = "https://checkout.stripe.com/c/pay/cs_test_123"

    # catalog
    async def search_events(self, **kw):
        self.calls.append(f"search:{kw}")
        out = []
        for e in self.events.values():
            if kw.get("category") and e["category"].lower() != kw["category"].lower():
                continue
            if kw.get("genre") and kw["genre"].lower() not in (e["category"] + " " + e["description"]).lower():
                continue
            if kw.get("title") and e["title"].lower() != kw["title"].lower():
                continue
            if kw.get("text") and not all(t in (e["title"] + " " + e["venue"]).lower() for t in kw["text"].lower().split()):
                continue
            if kw.get("exclude") and e["_id"] in kw["exclude"]:
                continue
            if kw.get("live") and e["category"] == "Movie":
                continue
            out.append({**e, "isUpcoming": True})
        page, limit = kw.get("page") or 1, kw.get("limit") or 5
        return {"data": out[(page - 1) * limit: page * limit], "total": len(out)}

    async def get_event(self, eid):
        if eid not in self.events:
            raise NodeAPIError(404, {"message": "Event not found"})
        return self.events[eid]

    async def get_facets(self):
        return {"categories": sorted({e["category"] for e in self.events.values()}), "venues": []}

    def _slots(self, eid):
        e = self.events[eid]
        return [{"date": d, "time": t, "showAt": f"{d}T{t}:00.000Z"} for d in e["_dates"] for t in sorted(e["showTimes"])]

    async def get_schedule(self, eid):
        slots = self._slots(eid)
        return {"eventId": eid, "dates": sorted({s["date"] for s in slots}), "slots": slots, "maxSeatsPerBooking": 10}

    async def get_availability(self, eid, show_at):
        e = self.events[eid]
        rows = [{"row": "A", "seats": [f"A{i}" for i in range(1, 11)]}, {"row": "B", "seats": [f"B{i}" for i in range(1, 11)]}]
        taken = self.booked.get(f"{eid}|{show_at}", set())
        available = [s for r in rows for s in r["seats"] if s not in taken]
        return {"rows": rows, "booked": sorted(taken), "locked": [], "available": available,
                "availableCount": len(available), "maxSeatsPerBooking": 10, "showAt": show_at, "price": e["price"]}

    # payments
    async def create_checkout(self, token, *, event_id, show_at, seats):
        self.calls.append(f"checkout:{event_id}:{show_at}:{','.join(seats)}")
        if self.checkout_error:
            raise self.checkout_error
        sid = f"cs_test_{len(self.orders) + 1}"
        order = {"sessionId": sid, "orderId": f"o{len(self.orders) + 1}", "status": "PENDING",
                 "checkoutUrl": self.checkout_url, "expiresAt": "2030-01-01T00:30:00.000Z",
                 "amountTotal": int(self.events[event_id]["price"] * 100) * len(seats), "currency": "inr",
                 "seats": seats, "eventId": event_id, "showAt": show_at, "ticketId": None, "user": token}
        self.orders[sid] = order
        return dict(order)

    async def get_order(self, token, sid):
        self.calls.append(f"order:{sid}")
        order = self.orders[sid]
        if order["user"] != token:
            raise NodeAPIError(403, {"message": "This payment does not belong to you."})
        return dict(order)

    async def cancel_order(self, token, sid):
        self.calls.append(f"cancel:{sid}")
        self.orders[sid]["status"] = "CANCELLED"
        return dict(self.orders[sid])

    def mark_paid(self, sid):
        """Simulates Stripe confirming payment and Node finalizing the booking."""
        order = self.orders[sid]
        order.update(status="PAID", ticketId="TKT-PAID-0001", bookingId="b1")
        self.booked.setdefault(f"{order['eventId']}|{order['showAt']}", set()).update(order["seats"])

    # bookings & refunds
    async def list_my_bookings(self, token):
        return [b for b in self.bookings.values() if b["_owner"] == token]

    async def get_booking_by_ticket(self, token, ticket_id):
        b = self.bookings.get(ticket_id)
        if not b or b["_owner"] != token:
            raise NodeAPIError(403, {"message": "Forbidden"})
        return b

    async def refund_quote(self, token, ticket_id):
        b = await self.get_booking_by_ticket(token, ticket_id)
        eligible = b["paymentStatus"] == "PAID" and not b.get("_within_24h")
        return {"booking": {"ticketId": ticket_id, "eventTitle": b["event"]["title"], "showAt": b["showAt"],
                            "seats": b["seats"], "seatNumbers": b["seatNumbers"], "paymentStatus": b["paymentStatus"],
                            "amountPaid": b["amountPaid"]},
                "quote": {"eligible": eligible, "refundPercent": 75 if eligible else 0,
                          "refundAmount": int(b["amountPaid"] * 0.75) if eligible else 0,
                          "reason": None if eligible else "Cancellations are not permitted within 24 hours of the show."}}

    async def request_refund(self, token, ticket_id):
        self.calls.append(f"refund:{ticket_id}")
        b = await self.get_booking_by_ticket(token, ticket_id)
        b["paymentStatus"] = "REFUNDED"
        return {"status": "REFUNDED", "booking": {"ticketId": ticket_id, "refundAmount": int(b["amountPaid"] * 0.75),
                                                  "refundStatus": "pending", "paymentStatus": "REFUNDED"}}

    async def refund_status(self, token, ticket_id):
        b = await self.get_booking_by_ticket(token, ticket_id)
        return {"booking": {"ticketId": ticket_id, "eventTitle": b["event"]["title"], "paymentStatus": b["paymentStatus"],
                            "refundStatus": "pending", "refundAmount": int(b["amountPaid"] * 0.75), "refundPercent": 75}}

    def add_booking(self, token, ticket_id, title, within_24h=False):
        self.bookings[ticket_id] = {"_id": f"b_{ticket_id}", "ticketId": ticket_id, "event": {"_id": "e_comedy1", "title": title},
                                    "showAt": "2030-01-10T19:00:00.000Z", "seats": 2, "seatNumbers": ["A1", "A2"],
                                    "paymentStatus": "PAID", "amountPaid": 60000, "_owner": token, "_within_24h": within_24h}


@pytest.fixture
def fake_node(monkeypatch):
    fake = FakeNode()
    for name in ("search_events", "get_event", "get_facets", "get_schedule", "get_availability", "create_checkout",
                 "get_order", "cancel_order", "list_my_bookings", "get_booking_by_ticket", "refund_quote",
                 "request_refund", "refund_status"):
        monkeypatch.setattr(node_client, name, getattr(fake, name))
    from app.tools import catalog
    catalog._facet_cache.update(at=0.0, value=None)
    return fake


class ScriptedModel:
    """Maps a user message to the Extraction Model 1 would return."""

    def __init__(self):
        self.rules: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {}
        self.contexts: List[Dict[str, Any]] = []

    def on(self, message: str, **fields):
        self.rules[message] = (lambda ctx: fields) if not callable(fields.get("_fn")) else fields["_fn"]

    async def __call__(self, schema, system, user):
        payload = json.loads(user)
        self.contexts.append(payload["CONTEXT"])
        msg = payload["LATEST_MESSAGE"]
        if msg not in self.rules:
            raise AssertionError(f"No scripted extraction for {msg!r}")
        fields = dict(self.rules[msg](payload["CONTEXT"]))
        fields.setdefault("confidence", 0.95)
        return Extraction(**fields)


@pytest.fixture
def model(monkeypatch):
    scripted = ScriptedModel()
    monkeypatch.setattr(intent_module, "extract", scripted)
    return scripted


@pytest_asyncio.fixture
async def graph():
    await workflow.close_checkpointer()
    await workflow.init_checkpointer()
    yield workflow
    await workflow.close_checkpointer()


class Chat:
    def __init__(self, wf, user_id="u1", authenticated=True, conversation="conv-test-1", city=None):
        self.wf = wf
        self.city = city
        self.user_id = user_id
        self.token = make_token(user_id) if authenticated else None
        self.authenticated = authenticated
        self.conversation = conversation

    async def say(self, text: str) -> Dict[str, Any]:
        return await self.wf.run_turn(
            query=text, conversation_id=self.conversation, user_id=self.user_id, user_name="Asha Rao",
            is_authenticated=self.authenticated, auth_token=self.token, city=self.city,
        )
