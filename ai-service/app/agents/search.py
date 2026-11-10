"""
Event Search agent: EVENT_SEARCH (discovery, contextual follow-ups) and EVENT_DETAILS.

Data always comes from Node/MongoDB. Model 2 only writes a short narrative from the
authoritative JSON; every factual line (titles, venues, prices, dates, seats) is rendered
deterministically from that same data.
"""

import asyncio
import copy
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from app.agents.common import backend_error_text, fmt_date, fmt_time, language_instruction, make_reply, rupees
from app.agents.resolve import remember_events, resolve_event_reference
from app.graph.state import empty_search
from app.llm import LLMUnavailable, generate
from app.tools import catalog as catalog_tools
from app.understanding.policy import plan_search, requested_filters
from services.node_client import NodeAPIError, NodeUnavailable

logger = logging.getLogger(__name__)

AGENT = "event_search_agent"
PAGE_SIZE = 5


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
    start, end = filters.get("date_from"), filters.get("date_to")
    if start and start == end:
        label += f" on {fmt_date(start)}"
    elif start or end:
        label += f" ({fmt_date(start) if start else '…'} to {fmt_date(end) if end else '…'})"
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


async def _fetch_filtered(filters: Dict[str, Any], rejected: List[str], page: int, seen: List[str]) -> Tuple[List[Dict[str, Any]], int, int]:
    """One page of the filtered search, skipping anything already shown (the catalog may change between pages)."""
    events: List[Dict[str, Any]] = []
    total = 0
    for _ in range(3):
        result = await catalog_tools.search_events(**filters, exclude=rejected, page=page, limit=PAGE_SIZE)
        total = result["total"]
        events = [e for e in result["events"] if e["id"] not in seen]
        if events or (page * PAGE_SIZE) >= total:
            break
        page += 1
    return events, total, page


async def _fetch_mix(categories: List[str], filters: Dict[str, Any], rejected: List[str], page: int, seen: List[str]) -> Tuple[List[Dict[str, Any]], int]:
    """One page across several categories: the top unseen event(s) of each, interleaved."""
    categories = categories[:PAGE_SIZE]
    if not categories:
        return [], 0
    per = max(1, -(-PAGE_SIZE // len(categories)))
    results = await asyncio.gather(
        *(catalog_tools.search_events(**{**filters, "category": c}, exclude=rejected, page=page, limit=per) for c in categories)
    )
    total = sum(r["total"] for r in results)
    columns = [[e for e in r["events"] if e["id"] not in seen] for r in results]
    events: List[Dict[str, Any]] = []
    for row in range(per):
        events += [col[row] for col in columns if len(col) > row]
    return events[:PAGE_SIZE], total


async def run_search(state: Dict[str, Any], entities: Dict[str, Any], query: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    One search session = one plan from the policy (fixed filters, or a mix of categories),
    paged through in a fixed (relevance) order so results never repeat. Rejected events are
    always excluded, and every event ever shown stays in search["catalog"] (selectable by id).
    """
    search = copy.deepcopy(state.get("search") or empty_search())
    spec = dict(entities.get("search") or {})
    if not requested_filters(spec) and entities.get("event_title"):
        spec["text"] = entities["event_title"]

    facets = await catalog_tools.get_facets()
    plan = plan_search(search, spec, facets.get("categories") or [])
    rejected = list(dict.fromkeys((search.get("rejected") or []) + list(spec.get("reject_event_ids") or [])))
    continuing = plan["continue"]
    filters = plan["filters"]
    page = int(search.get("page") or 1) + 1 if continuing else 1
    seen = list(search.get("seen") or []) if continuing else []

    if plan["kind"] == "mix":
        label = "events of other kinds"
    else:
        label = _describe_filters(filters)

    try:
        if plan["kind"] == "mix":
            events, total = await _fetch_mix(plan["categories"], filters, rejected, page, seen)
        else:
            events, total, page = await _fetch_filtered(filters, rejected, page, seen)
    except (NodeUnavailable, NodeAPIError) as exc:
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), search

    shown_categories = list(search.get("shown_categories") or []) if plan["keep_shown_categories"] else []
    search.update(
        filters=filters,
        mix={"categories": plan["categories"]} if plan["kind"] == "mix" else None,
        page=page,
        total=total,
        rejected=rejected,
        focus=None,
        shown_categories=shown_categories,
    )

    if not events:
        search["last_results"] = []
        if continuing:
            text = f"You've seen all {total} {label} I have. Want to search for something else?"
        else:
            text = f"I couldn't find any {label}. Try a different title, genre, category or venue?"
        quick = [f"Show me {c}" for c in (facets.get("categories") or []) if c not in shown_categories][:4]
        return make_reply(text, AGENT, quick_replies=quick or ["Show me movies", "Show me events"]), search

    remember_events(search, events, as_last_results=True)
    search["seen"] = list(dict.fromkeys(seen + [e["id"] for e in events]))
    new_categories = [e["category"] for e in events if e.get("category")]
    search["shown_categories"] = list(dict.fromkeys(shown_categories + new_categories))
    shown_to = min(len(search["seen"]), total)

    if plan["kind"] == "mix" and not continuing:
        kinds = ", ".join(dict.fromkeys(new_categories))
        text = f"Here's something different — {kinds} 👇"
    else:
        text = _intro(label, shown_to - len(events) + 1, shown_to, total, continuing)
    if not any(e.get("upcoming") for e in events):
        text += "\n\nNone of these currently have upcoming shows to book."
    else:
        text += "\nTap **Book** on any card to pick your show and seats."

    quick = []
    if shown_to < total:
        quick.append("Show me more")
    if plan["kind"] == "mix":
        quick += [f"Show me {c}" for c in dict.fromkeys(new_categories)][:3]
    else:
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
        about = await generate(
            DETAILS_SYSTEM + language_instruction(entities.get("_language")),
            json.dumps(about_data, ensure_ascii=False),
            temperature=0.4,
        )
    except LLMUnavailable:
        about = event.get("description") or f"{event.get('title')} is a {str(event.get('category') or 'live').lower()} event."

    text = f"**{event['title']}**\n\n{about}\n\n{_facts_block(event, schedule)}"
    quick = [f"Book {event['title']}", "Show me something else"]
    return make_reply(text, AGENT, quick_replies=quick), search
