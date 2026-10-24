"""
Transactional tools: checkout, payment status, bookings and refunds.

Each call carries the end user's JWT; Node verifies identity, ownership, price, seat
availability, payment status and refund policy. Results are returned exactly as Node
reports them — callers must never infer success that Node did not state.
"""

from typing import Any, Dict, List

from services.node_client import node_client


def normalize_booking(raw: Dict[str, Any]) -> Dict[str, Any]:
    event = raw.get("event") if isinstance(raw.get("event"), dict) else {}
    return {
        "booking_id": str(raw.get("_id") or raw.get("bookingId") or ""),
        "ticket_id": raw.get("ticketId"),
        "event_id": str(event.get("_id") or event.get("id") or raw.get("event") or "") or None,
        "event_title": event.get("title") or raw.get("eventTitle"),
        "venue": event.get("venue"),
        "show_at": raw.get("showAt"),
        "seats": raw.get("seats"),
        "seat_numbers": list(raw.get("seatNumbers") or []),
        "payment_status": raw.get("paymentStatus"),
        "amount_paid": raw.get("amountPaid"),
        "currency": raw.get("currency") or "inr",
        "refund_status": raw.get("refundStatus"),
        "refund_amount": raw.get("refundAmount"),
        "refund_percent": raw.get("refundPercent"),
        "cancelled_at": raw.get("cancelledAt"),
    }


def normalize_refund_view(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "booking_id": raw.get("bookingId"),
        "ticket_id": raw.get("ticketId"),
        "event_title": raw.get("eventTitle"),
        "show_at": raw.get("showAt"),
        "seats": raw.get("seats"),
        "seat_numbers": list(raw.get("seatNumbers") or []),
        "payment_status": raw.get("paymentStatus"),
        "amount_paid": raw.get("amountPaid"),
        "currency": raw.get("currency") or "inr",
        "refund_id": raw.get("refundId"),
        "refund_status": raw.get("refundStatus"),
        "refund_amount": raw.get("refundAmount"),
        "refund_percent": raw.get("refundPercent"),
        "cancelled_at": raw.get("cancelledAt"),
    }


async def create_checkout(token: str, *, event_id: str, show_at: str, seats: List[str]) -> Dict[str, Any]:
    return await node_client.create_checkout(token, event_id=event_id, show_at=show_at, seats=seats)


async def get_order(token: str, session_id: str) -> Dict[str, Any]:
    return await node_client.get_order(token, session_id)


async def cancel_order(token: str, session_id: str) -> Dict[str, Any]:
    return await node_client.cancel_order(token, session_id)


async def list_bookings(token: str) -> List[Dict[str, Any]]:
    return [normalize_booking(b) for b in await node_client.list_my_bookings(token)]


async def get_booking(token: str, ticket_id: str) -> Dict[str, Any]:
    return normalize_booking(await node_client.get_booking_by_ticket(token, ticket_id))


async def refund_quote(token: str, ticket_id: str) -> Dict[str, Any]:
    body = await node_client.refund_quote(token, ticket_id)
    return {"booking": normalize_refund_view(body.get("booking") or {}), "quote": body.get("quote") or {}}


async def refund_status(token: str, ticket_id: str) -> Dict[str, Any]:
    body = await node_client.refund_status(token, ticket_id)
    return normalize_refund_view(body.get("booking") or {})


async def request_refund(token: str, ticket_id: str) -> Dict[str, Any]:
    body = await node_client.request_refund(token, ticket_id)
    return {
        "status": body.get("status"),
        "booking": normalize_refund_view(body.get("booking") or {}),
        "quote": body.get("quote") or {},
    }
