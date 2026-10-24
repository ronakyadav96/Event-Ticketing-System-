"""
Resolve which event the user is referring to — deterministically, from authoritative data.

Order: an explicit known event_id (validated against events shown in this conversation)
→ a named title (exact match in this conversation, else a Node title search that must be
unambiguous) → the caller-provided fallback (e.g. the event in focus). A search result is
never chosen just because it was listed first.
"""

from typing import Any, Dict, List, Optional, Tuple

from app.tools import catalog as catalog_tools


async def resolve_event_reference(
    search: Dict[str, Any],
    entities: Dict[str, Any],
    *,
    fallback_id: Optional[str] = None,
) -> Tuple[str, Any]:
    """Returns ("found", event) | ("ambiguous", [events]) | ("none", None)."""
    known: Dict[str, Dict[str, Any]] = search.get("catalog") or {}

    event_id = entities.get("event_id")
    if event_id and event_id in known:
        return "found", known[event_id]

    title = (entities.get("event_title") or "").strip()
    if title:
        exact = [ev for ev in known.values() if (ev.get("title") or "").strip().lower() == title.lower()]
        if len(exact) == 1:
            return "found", exact[0]

        candidates = (await catalog_tools.search_events(text=title, limit=6))["events"]
        exact_remote = [ev for ev in candidates if (ev.get("title") or "").strip().lower() == title.lower()]
        if len(exact_remote) == 1:
            return "found", exact_remote[0]
        pool: List[Dict[str, Any]] = exact_remote or candidates
        if len(pool) == 1:
            return "found", pool[0]
        if pool:
            return "ambiguous", pool
        return "none", None

    if fallback_id and fallback_id in known:
        return "found", known[fallback_id]
    return "none", None


def remember_events(search: Dict[str, Any], events: List[Dict[str, Any]], *, as_last_results: bool) -> None:
    """Add events to the conversation catalog (all shown events stay selectable)."""
    catalog = search.setdefault("catalog", {})
    for ev in events:
        if ev.get("id"):
            catalog[ev["id"]] = ev
    if as_last_results:
        search["last_results"] = [ev["id"] for ev in events if ev.get("id")]
