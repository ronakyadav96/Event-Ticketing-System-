"""
Event Search agent: EVENT_SEARCH (discovery, contextual follow-ups) and EVENT_DETAILS.

Data always comes from Node/MongoDB. Model 2 only writes a short narrative from the
authoritative JSON; every factual line (titles, venues, prices, dates, seats) is rendered
deterministically from that same data.
"""

import copy
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from app.agents.common import backend_error_text, fmt_date, fmt_time, make_reply, rupees
from app.agents.resolve import remember_events, resolve_event_reference
from app.graph.state import empty_search
from app.llm import LLMUnavailable, generate
from app.tools import catalog as catalog_tools
from services.node_client import NodeAPIError, NodeUnavailable

logger = logging.getLogger(__name__)

AGENT = "event_search_agent"
PAGE_SIZE = 5
_FILTER_KEYS = ("text", "category", "genre", "venue", "date_from", "date_to", "max_price")


def _describe_filters(filters: Dict[str, Any]) -> str:
    parts = []
    if filters.get("genre"):
        parts.append(str(filters["genre"]))
    if filters.get("category"):
        parts.append(str(filters["category"]).lower())
    label = f"{' '.join(parts)} events" if parts else "events"
    if filters.get("text"):
        label += f" matching “{filters['text']}”"
    if filters.get("venue"):
        label += f" at {filters['venue']}"
    if filters.get("max_price"):
        label += f" under {rupees(filters['max_price'])}"
    if filters.get("date_from") or filters.get("date_to"):
        label += f" ({filters.get('date_from') or '…'} to {filters.get('date_to') or '…'})"
    return label


def _result_lines(events: List[Dict[str, Any]], start: int = 1) -> str:
    lines = []
    for i, ev in enumerate(events, start):
        bits = [b for b in (ev.get("category"), ev.get("venue")) if b]
        price = f" · {rupees(ev['price'])}" if ev.get("price") is not None else ""
        status = " · no upcoming shows" if ev.get("upcoming") is False else ""
        lines.append(f"{i}. **{ev.get('title')}** — {' · '.join(bits)}{price}{status}")
    return "\n".join(lines)


def _intro(label: str, shown_from: int, shown_to: int, total: int, continuing: bool) -> str:
    """Deterministic, instant intro. The events themselves are rendered as cards by the UI."""
    if continuing:
        return f"Here are {shown_to - shown_from + 1} more {label} ({shown_from}–{shown_to} of {total}) 👇"
    if total == 1:
        return f"I found 1 {label.replace('events', 'event', 1)} 👇"
    if total <= shown_to:
        return f"I found {total} {label} 👇"
    return f"I found {total} {label} — here are the top {shown_to} 👇"


def _same_search(requested: Dict[str, Any], previous: Dict[str, Any]) -> bool:
    """A follow-up keeps the current search if it adds nothing new (the model often repeats filters)."""
    return all(str(previous.get(k, "")).lower() == str(v).lower() for k, v in requested.items())


async def run_search(state: Dict[str, Any], entities: Dict[str, Any], query: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    One search session = one set of filters, paged through in a fixed (relevance) order.

    - New filters (category, genre, title, venue, ...) → a fresh MongoDB search, page 1.
    - "another" / "more" / "something else" with nothing new → the next page of the same search,
      so results never repeat; rejected events are always excluded.
    - Every event ever shown stays in search["catalog"] (selectable later by its id).
    """
    search = copy.deepcopy(state.get("search") or empty_search())
    spec = entities.get("search") or {}

    rejected = list(dict.fromkeys((search.get("rejected") or []) + list(spec.get("reject_event_ids") or [])))
    requested = {k: spec.get(k) for k in _FILTER_KEYS if spec.get(k) not in (None, "")}
    if not requested and entities.get("event_title"):
        requested = {"text": entities["event_title"]}

    previous = dict(search.get("filters") or {})
    has_previous = bool(previous) or bool(search.get("seen"))
    wants_more = bool(spec.get("more_results")) or bool(spec.get("reject_event_ids"))
    # Asking again for exactly the same search also pages forward instead of repeating page 1.
    repeated = bool(requested) and requested == previous
    continuing = has_previous and (repeated or (wants_more and _same_search(requested, previous)))

    if continuing:
        filters = previous
        page = int(search.get("page") or 1) + 1
        seen = list(search.get("seen") or [])
    else:
        filters = requested
        page = 1
        seen = []

    label = _describe_filters(filters)
    events: List[Dict[str, Any]] = []
    total = 0
    try:
        # Skip anything already shown in this search (e.g. if the catalog changed between pages).
        for _ in range(3):
            result = await catalog_tools.search_events(**filters, exclude=rejected, page=page, limit=PAGE_SIZE)
            total = result["total"]
            events = [e for e in result["events"] if e["id"] not in seen]
            if events or (page * PAGE_SIZE) >= total:
                break
            page += 1
    except (NodeUnavailable, NodeAPIError) as exc:
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), search

    search.update(filters=filters, page=page, total=total, rejected=rejected, focus=None)

    if not events:
        search["last_results"] = []
        if continuing:
            text = f"You've seen all {total} {label} I have. Want to search for something else?"
        else:
            text = f"I couldn't find any {label}. Try a different title, genre, category or venue?"
        return make_reply(text, AGENT, quick_replies=["Show me movies", "Show me events"]), search

    remember_events(search, events, as_last_results=True)
    search["seen"] = list(dict.fromkeys(seen + [e["id"] for e in events]))
    shown_to = min(len(search["seen"]), total)

    text = _intro(label, shown_to - len(events) + 1, shown_to, total, continuing)
    if not any(e.get("upcoming") for e in events):
        text += "\n\nNone of these currently have upcoming shows to book."
    else:
        text += "\nTap **Book** on any card to pick your show and seats."
    quick = []
    if shown_to < total:
        quick.append("Show me more")
    quick += [f"Book {e['title']}" for e in events if e.get("upcoming")][:2]
    return make_reply(text, AGENT, events=events, quick_replies=quick), search


DETAILS_SYSTEM = """You describe one event for a ticket-booking chat in 2–4 sentences.
Use ONLY the provided JSON (title, category, description, rating, release date). Do not state prices,
venues, dates, showtimes, seat availability or discounts — those are shown separately from the booking
system. If the description is empty, say briefly what kind of event it is based on its category."""


def _facts_block(event: Dict[str, Any], schedule: Optional[Dict[str, Any]]) -> str:
    lines = []
    if event.get("venue"):
        lines.append(f"📍 **Venue:** {event['venue']}")
    if event.get("price") is not None:
        lines.append(f"💰 **Price:** {rupees(event['price'])} per ticket")
    if schedule is not None:
        slots = schedule.get("slots") or []
        if slots:
            dates = schedule.get("dates") or []
            times = sorted({s["time"] for s in slots})
            date_text = ", ".join(fmt_date(d) for d in dates[:4]) + (f" (+{len(dates) - 4} more)" if len(dates) > 4 else "")
            lines.append(f"📅 **Upcoming dates:** {date_text}")
            lines.append(f"🕒 **Showtimes:** {', '.join(fmt_time(t) for t in times)}")
        else:
            lines.append("📅 No upcoming shows are currently scheduled.")
    if event.get("available_seats") is not None:
        lines.append(f"🎟️ **Seats remaining:** {event['available_seats']}")
    return "\n".join(lines)


async def run_details(state: Dict[str, Any], entities: Dict[str, Any], query: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    search = copy.deepcopy(state.get("search") or empty_search())
    last = search.get("last_results") or []
    fallback = search.get("focus") or (last[0] if len(last) == 1 else None)

    try:
        outcome, value = await resolve_event_reference(search, entities, fallback_id=fallback)
    except (NodeUnavailable, NodeAPIError) as exc:
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), search

    if outcome == "ambiguous":
        remember_events(search, value, as_last_results=True)
        text = "I found a few events that could match. Which one did you mean?\n\n" + _result_lines(value)
        return make_reply(text, AGENT, events=value, quick_replies=[f"Tell me about {e['title']}" for e in value[:4]]), search
    if outcome == "none":
        named = entities.get("event_title")
        text = (
            f"I couldn't find an event called “{named}”." if named else "Which event would you like to know more about?"
        )
        return make_reply(text, AGENT, quick_replies=["Show me movies", "Upcoming events"]), search

    try:
        event = await catalog_tools.get_event(value["id"])
    except NodeAPIError:
        return make_reply("That event is no longer available.", AGENT), search
    except NodeUnavailable as exc:
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), search

    try:
        schedule = await catalog_tools.get_schedule(event["id"])
    except (NodeUnavailable, NodeAPIError):
        schedule = None

    remember_events(search, [event], as_last_results=False)
    search["focus"] = event["id"]

    about_data = {k: event.get(k) for k in ("title", "category", "description", "rating", "release_date")}
    try:
        about = await generate(DETAILS_SYSTEM, json.dumps(about_data, ensure_ascii=False), temperature=0.4)
    except LLMUnavailable:
        about = event.get("description") or f"{event.get('title')} is a {str(event.get('category') or 'live').lower()} event."

    text = f"**{event['title']}**\n\n{about}\n\n{_facts_block(event, schedule)}"
    quick = [f"Book {event['title']}", "Show me something else"]
    return make_reply(text, AGENT, quick_replies=quick), search
