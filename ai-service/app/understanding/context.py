"""Compact, model-facing views of the conversation state."""

from datetime import datetime
from typing import Any, Dict, List
from zoneinfo import ZoneInfo

from app.graph.state import BookingStage, RefundStage
from config import settings


def today() -> datetime:
    return datetime.now(ZoneInfo(settings.EVENT_TIMEZONE))


def recent_turns(messages: List[Any], limit: int = 6) -> List[Dict[str, str]]:
    """The turns before the latest user message."""
    turns = []
    for m in messages[-(limit + 1):-1]:
        role = "user" if getattr(m, "type", "") == "human" else "assistant"
        turns.append({"role": role, "text": str(getattr(m, "content", ""))[:400]})
    return turns


def _booking_context(booking: Dict[str, Any]) -> Dict[str, Any]:
    ctx: Dict[str, Any] = {"stage": booking.get("stage", BookingStage.IDLE.value)}
    if booking.get("event"):
        ctx["event"] = {"id": booking["event"].get("id"), "title": booking["event"].get("title")}
    offered = booking.get("options") or {}
    for key in ("venues", "dates", "times", "max_quantity", "suggested_seats"):
        if offered.get(key):
            ctx[f"offered_{key}"] = offered[key]
    return ctx


def _last_search(search: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "filters": search.get("filters") or {},
        "mix_of_categories": (search.get("mix") or {}).get("categories") or None,
        "shown_categories": search.get("shown_categories") or [],
    }


def rewrite_context(state: Dict[str, Any]) -> Dict[str, Any]:
    """What the rewrite step needs to resolve references: titles in display order, not ids."""
    search = state.get("search") or {}
    catalog = search.get("catalog") or {}
    last = [catalog[i] for i in search.get("last_results") or [] if i in catalog]
    focus = catalog.get(search.get("focus") or "")
    return {
        "today": today().strftime("%Y-%m-%d (%A)"),
        "last_results": [{"position": n, "title": e.get("title"), "category": e.get("category")} for n, e in enumerate(last, 1)],
        "focus_event": focus.get("title") if focus else None,
        "last_search": _last_search(search),
        "booking": _booking_context(state.get("booking") or {}),
        "refund_stage": (state.get("refund") or {}).get("stage", RefundStage.IDLE.value),
    }


def tracker_context(state: Dict[str, Any], facets: Dict[str, Any]) -> Dict[str, Any]:
    """Everything the state-update step may rely on, including the ids it may copy."""
    search = state.get("search") or {}
    refund = state.get("refund") or {}
    catalog = search.get("catalog") or {}
    last = search.get("last_results") or []

    known = []
    for eid, ev in catalog.items():
        entry = {"id": eid, "title": ev.get("title"), "category": ev.get("category"), "venue": ev.get("venue")}
        if eid in last:
            entry["last_results_position"] = last.index(eid) + 1
        known.append(entry)

    return {
        "today": today().strftime("%Y-%m-%d (%A)"),
        "catalog_categories": facets.get("categories") or [],
        "known_events": known[-40:],
        "focus_event_id": search.get("focus"),
        "last_search": _last_search(search),
        "booking": _booking_context(state.get("booking") or {}),
        "refund": {
            "stage": refund.get("stage", RefundStage.IDLE.value),
            "ticket_id": refund.get("ticket_id"),
            "options": refund.get("options") or [],
        },
    }
