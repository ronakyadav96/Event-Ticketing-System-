"""
Catalog tools: event search, event details, schedules and seat availability.

All data comes from the Node backend. Events are normalized into a small, explicit
summary so agents and the UI only ever see authoritative fields.
"""

import html
import re
import time
from typing import Any, Dict, List, Optional

from services.node_client import node_client

_FACET_TTL_SECONDS = 300
_facet_cache: Dict[str, Any] = {"at": 0.0, "value": None}


def event_id_of(raw: Dict[str, Any]) -> str:
    return str(raw.get("_id") or raw.get("id") or "")


def _plain_text(value: Any) -> str:
    """Event descriptions are creator-entered and may contain HTML; keep only the text."""
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def normalize_event(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Authoritative event summary. Missing fields stay missing — nothing is invented."""
    total = raw.get("totalSeats")
    booked = raw.get("bookedSeats") or 0
    meta = raw.get("movieMeta") or {}
    description = _plain_text(raw.get("description"))
    return {
        "id": event_id_of(raw),
        "title": raw.get("title"),
        "category": raw.get("category"),
        "venue": raw.get("venue"),
        "price": raw.get("price"),
        "currency": "inr",
        "start_date": (raw.get("startDate") or raw.get("date") or None),
        "end_date": (raw.get("endDate") or raw.get("startDate") or raw.get("date") or None),
        "show_times": list(raw.get("showTimes") or []),
        "description": description[:600] if description else None,
        "image_url": raw.get("imageUrl") or meta.get("posterUrl") or None,
        "available_seats": max(0, int(total) - int(booked)) if isinstance(total, (int, float)) else None,
        "rating": meta.get("voteAverage") or None,
        # From the relevance search: the event's run has not ended (it may have bookable shows).
        "upcoming": raw.get("isUpcoming"),
        "release_date": meta.get("releaseDate") or None,
    }


async def search_events(
    *,
    text: Optional[str] = None,
    category: Optional[str] = None,
    genre: Optional[str] = None,
    venue: Optional[str] = None,
    title: Optional[str] = None,
    max_price: Optional[float] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    exclude: Optional[List[str]] = None,
    page: int = 1,
    limit: int = 5,
) -> Dict[str, Any]:
    """One page of matching events from MongoDB (via Node): {"events": [...], "total": n}."""
    body = await node_client.search_events(
        text=text,
        category=category,
        genre=genre,
        venue=venue,
        title=title,
        max_price=max_price,
        date_from=date_from,
        date_to=date_to,
        exclude=exclude,
        page=page,
        limit=limit,
    )
    return {"events": [normalize_event(e) for e in body["data"] if event_id_of(e)], "total": body["total"]}


async def get_event(event_id: str) -> Dict[str, Any]:
    return normalize_event(await node_client.get_event(event_id))


async def get_schedule(event_id: str) -> Dict[str, Any]:
    return await node_client.get_schedule(event_id)


async def get_availability(event_id: str, show_at: str) -> Dict[str, Any]:
    return await node_client.get_availability(event_id, show_at)


async def get_facets() -> Dict[str, Any]:
    """Catalog categories/venues (cached briefly). Returns empty lists if unavailable."""
    now = time.monotonic()
    if _facet_cache["value"] is not None and now - _facet_cache["at"] < _FACET_TTL_SECONDS:
        return _facet_cache["value"]
    try:
        value = await node_client.get_facets()
    except Exception:
        return _facet_cache["value"] or {"categories": [], "venues": []}
    _facet_cache.update(at=now, value=value)
    return value
