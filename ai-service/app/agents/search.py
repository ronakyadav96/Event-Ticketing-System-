"""
Event Search agent: EVENT_SEARCH (discovery, contextual follow-ups) and EVENT_DETAILS.

Data always comes from Node/MongoDB and every factual line is rendered deterministically from
it. Results are shown in the app itself: each reply carries a `view` (the explore page query, or
the event page) that the frontend navigates to.
"""

import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from app.agents import lang
from app.agents.common import backend_error_text, fmt_date, fmt_time, make_reply, rupees
from app.agents.resolve import remember_events, resolve_event_reference
from app.graph.state import empty_search
from app.tools import catalog as catalog_tools
from services.node_client import NodeAPIError, NodeUnavailable

logger = logging.getLogger(__name__)

AGENT = "event_search_agent"
# Same page size as the app's explore page, so "the second one" means the second card on screen.
PAGE_SIZE = 20
_FILTER_KEYS = ("text", "category", "genre", "venue", "city", "date_from", "date_to", "max_price", "live")


def _label(filters: Dict[str, Any]) -> str:
    """"comedy shows", "action movies", "events" — the thing being listed."""
    category = str(filters.get("category") or "").lower()
    base = lang.CATEGORY_LABELS.get(category, f"{category} events" if category else "events")
    genre = filters.get("genre")
    return f"{genre} {base}" if genre and genre.lower() not in base else base


def _where(filters: Dict[str, Any], lang_code: str) -> Dict[str, str]:
    """Location / text / date phrases for the reply templates, in both languages."""
    city = filters.get("city")
    venue = filters.get("venue")
    place = venue or city
    text = filters.get("text")
    when = ""
    if filters.get("date_from") or filters.get("date_to"):
        start, end = filters.get("date_from"), filters.get("date_to")
        when = fmt_date(start) if start == end else f"{fmt_date(start)} – {fmt_date(end)}"
    price = f"under {rupees(filters['max_price'])}" if filters.get("max_price") else ""
    price_hi = f"{rupees(filters['max_price'])} se kam" if filters.get("max_price") else ""

    en = ""
    if text:
        en += f" matching “{text}”"
    if place:
        en += f" in {place}"
    if when:
        en += f" ({when})"
    if price:
        en += f" {price}"

    hi_bits = [b for b in (f"“{text}” ke liye" if text else "", f"{place} me" if place else "", when, price_hi) if b]
    hi = " ".join(hi_bits)
    return {
        "where": en,
        "where_hi": f"{hi} " if hi else "",
        "where_tail_hi": f" {hi}" if hi else "",
        "where_mid_hi": f" {place} ke" if place else "",
    }


def _view(filters: Dict[str, Any], page: int, query: str) -> Dict[str, Any]:
    """Query parameters for the app's /explore page that reproduce exactly this search."""
    params = {
        "q": filters.get("text"),
        "category": filters.get("category"),
        "genre": filters.get("genre"),
        "venue": filters.get("venue"),
        "city": filters.get("city"),
        "from": filters.get("date_from"),
        "to": filters.get("date_to"),
        "maxPrice": filters.get("max_price"),
        "live": "true" if filters.get("live") else None,
        "sort": "relevance",
        "p": page if page > 1 else None,
        "src": "chat",
        "ai": query[:120],
    }
    return {"type": "explore", "params": {k: v for k, v in params.items() if v not in (None, "")}}


def _node_filters(filters: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in filters.items() if k in _FILTER_KEYS and v not in (None, "", False)}


def _result_lines(events: List[Dict[str, Any]], start: int = 1) -> str:
    lines = []
    for i, ev in enumerate(events, start):
        bits = [b for b in (ev.get("category"), ev.get("venue")) if b]
        price = f" · {rupees(ev['price'])}" if ev.get("price") is not None else ""
        lines.append(f"{i}. **{ev.get('title')}** — {' · '.join(bits)}{price}")
    return "\n".join(lines)


def _same_search(requested: Dict[str, Any], previous: Dict[str, Any]) -> bool:
    """A follow-up keeps the current search if it adds nothing new (the model often repeats filters)."""
    return all(str(previous.get(k, "")).lower() == str(v).lower() for k, v in requested.items())


async def run_search(state: Dict[str, Any], entities: Dict[str, Any], query: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    One search session = one set of filters, paged through in a fixed (relevance) order.

    - New filters (category, genre, title, city, ...) → a fresh search, page 1.
    - "another" / "more" / "aur dikhao" with nothing new → the next page of the same search.
    - Results are shown in the app (explore page) via `view`; every event shown stays in
      search["catalog"] so later turns can refer to it ("book the second one").
    """
    lang_code = state.get("lang") or lang.EN
    search = copy.deepcopy(state.get("search") or empty_search())
    spec = entities.get("search") or {}

    requested = {k: spec.get(k) for k in _FILTER_KEYS if spec.get(k) not in (None, "", False)}
    if not requested and entities.get("event_title"):
        requested = {"text": entities["event_title"]}
    # Searches default to the city selected in the app.
    if not requested.get("city") and state.get("city"):
        requested["city"] = state["city"]

    previous = dict(search.get("filters") or {})
    has_previous = bool(previous) or bool(search.get("seen"))
    wants_more = bool(spec.get("more_results")) or bool(spec.get("reject_event_ids"))
    repeated = bool(requested) and requested == previous
    continuing = has_previous and (repeated or (wants_more and _same_search(requested, previous)))

    filters = previous if continuing else requested
    page = int(search.get("page") or 1) + 1 if continuing else 1
    relaxed_text = None

    try:
        result = await catalog_tools.search_events(**_node_filters(filters), upcoming=True, page=page, limit=PAGE_SIZE)
        # Nothing for a specific topic ("cricket") inside a category: show the whole category instead.
        if not continuing and result["total"] == 0 and filters.get("text") and filters.get("category"):
            relaxed_text = filters["text"]
            filters = {k: v for k, v in filters.items() if k != "text"}
            result = await catalog_tools.search_events(**_node_filters(filters), upcoming=True, page=1, limit=PAGE_SIZE)
    except (NodeUnavailable, NodeAPIError) as exc:
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), search

    events, total = result["events"], result["total"]
    search.update(filters=filters, page=page, total=total, focus=None)
    label = _label(filters)
    where = _where(filters, lang_code)
    chips = lang.SUGGESTIONS[lang_code]

    if not events:
        search["last_results"] = []
        if continuing:
            text = lang.t("seen_all", lang_code, n=total, label=label, **where)
        else:
            text = lang.t("none_found", lang_code, label=label, **where)
        return make_reply(text, AGENT, quick_replies=chips), search

    remember_events(search, events, as_last_results=True)
    seen_before = list(search.get("seen") or []) if continuing else []
    search["seen"] = list(dict.fromkeys(seen_before + [e["id"] for e in events]))
    shown_from = (page - 1) * PAGE_SIZE + 1
    shown_to = min(page * PAGE_SIZE, total)

    if continuing:
        text = lang.t("found_more", lang_code, label=label, start=shown_from, end=shown_to, n=total, **where)
    elif relaxed_text:
        text = lang.t("relaxed", lang_code, text=relaxed_text, label=label, **where)
    elif total == 1:
        text = lang.t("found_one", lang_code, label=label.rstrip("s") if label.endswith("s") else label, **where)
    else:
        text = lang.t("found_many", lang_code, n=total, label=label, **where)
    text += "\n" + lang.t("tap_to_book", lang_code)

    quick = []
    if shown_to < total:
        quick.append(lang.t("show_more", lang_code))
    quick += [f"Book {e['title']}" for e in events[:2]]
    return make_reply(text, AGENT, events=events, quick_replies=quick, view=_view(filters, page, query)), search


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
    """Opens the event's page in the app; the chat keeps a short factual summary."""
    lang_code = state.get("lang") or lang.EN
    search = copy.deepcopy(state.get("search") or empty_search())
    last = search.get("last_results") or []
    fallback = search.get("focus") or (last[0] if len(last) == 1 else None)

    try:
        outcome, value = await resolve_event_reference(search, entities, fallback_id=fallback)
    except (NodeUnavailable, NodeAPIError) as exc:
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), search

    if outcome == "ambiguous":
        remember_events(search, value, as_last_results=True)
        text = lang.t("ambiguous", lang_code) + "\n\n" + _result_lines(value)
        return make_reply(text, AGENT, events=value, quick_replies=[f"Tell me about {e['title']}" for e in value[:4]]), search
    if outcome == "none":
        named = entities.get("event_title")
        text = lang.t("not_found_named", lang_code, name=named) if named else lang.t("which_event", lang_code)
        return make_reply(text, AGENT, quick_replies=lang.SUGGESTIONS[lang_code]), search

    try:
        event = await catalog_tools.get_event(value["id"])
    except NodeAPIError:
        return make_reply(lang.t("no_longer", lang_code), AGENT), search
    except NodeUnavailable as exc:
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), search

    try:
        schedule = await catalog_tools.get_schedule(event["id"])
    except (NodeUnavailable, NodeAPIError):
        schedule = None

    remember_events(search, [event], as_last_results=False)
    search["focus"] = event["id"]

    text = f"{lang.t('opening_details', lang_code, title=event['title'])}\n\n{_facts_block(event, schedule)}"
    view = {"type": "event", "event_id": event["id"], "action": "details"}
    quick = [f"Book {event['title']}", lang.t("show_more", lang_code) if last else lang.SUGGESTIONS[lang_code][0]]
    return make_reply(text, AGENT, quick_replies=quick, view=view), search
