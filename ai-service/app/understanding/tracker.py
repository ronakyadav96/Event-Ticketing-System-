"""Step 2: report what the standalone request changes in the conversation state."""

import json
import logging
import re
from typing import Any, Dict, List

from app import llm
from app.understanding.context import recent_turns, tracker_context
from app.understanding.schemas import StateUpdate

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are the state tracker of "Tamasha AI", the event & movie ticket booking assistant of Tamasha.
STANDALONE_REQUEST is the user's latest message already rewritten into self-contained English
(LATEST_MESSAGE is what they literally typed). Using CONTEXT, report the intent and what changes.

INTENTS
- EVENT_SEARCH: find/browse events or movies, including "more", "another", "a different kind", added filters.
- EVENT_DETAILS: information about one specific event (what it is about, where/when it plays).
- BOOKING: start or continue booking: choosing an event to book, venue, date, showtime, ticket count, seats,
  confirming the summary, payment progress ("I paid"), or abandoning the booking in progress (cancel_draft).
- BOOKING_STATUS: the user's existing bookings / tickets.
- CANCEL_BOOKING: cancel an existing, already paid booking/ticket.
- REFUND: ask for money back for an existing booking.
- REFUND_STATUS: status of a refund already requested.
- FAQ_POLICY: rules and policies (refund/cancellation policy, payment methods, entry rules, ID, food, parking, support).
- SMALL_TALK: greetings, thanks, what can you do.
- OUT_OF_DOMAIN: unrelated to events, movies, tickets, bookings or this platform.
- UNKNOWN: unintelligible.

SEARCH ACTIONS (search.action, only for EVENT_SEARCH)
- NEW: a fresh search with its own criteria. Fill ONLY the new criteria; do not copy CONTEXT.last_search.filters.
  "show me events" with no criteria is NEW with no filters.
- MORE: more results of the SAME search ("another", "more", "next", "something else" without new criteria). No filters.
- REFINE: keep the current search and add/adjust a constraint ("only tomorrow", "cheaper than 500", "in Bandra").
  Fill only the added/changed filters; the system merges them with the current search.
- CHANGE_TYPE: a different kind of event than what was shown ("other types", "not movies", "something different
  than comedy"). If the user named the new kind, set category; put the kinds they no longer want in exclude_categories.

FILTER RULES
- category must be copied exactly from CONTEXT.catalog_categories (Movie, Comedy, Concert, ...). A genre such as
  horror or science fiction goes in genre, not category. "comedy show" → category Comedy.
- text holds only a title, performer or topic. Never put request words ("show", "another", "other type", "any")
  or category/genre words in text.
- Dates relative to CONTEXT.today. "tomorrow" → date_from = date_to = tomorrow. "this weekend" → Saturday..Sunday.

OTHER RULES
- If a booking is in progress and the request answers the current step (time, number, seats, "yes"), it is BOOKING.
- A yes/no answering a pending cancellation/refund question is CANCEL_BOOKING (or REFUND) with confirmation set.
- "Cancel" while a booking is in progress and no ticket ID is mentioned → BOOKING with cancel_draft=true.
- How cancellation or refunds work in general → FAQ_POLICY, not CANCEL_BOOKING.
- event_id must be copied from KNOWN EVENTS. Ordinals refer to last_results_position. If the user names an event
  not in KNOWN EVENTS, set event_title instead. Never pick an event the user did not refer to.
- reject_event_ids: only events the user explicitly rejected.
- When CONTEXT.refund.options lists ticket IDs and the user picks one (by ID or position), copy it into ticket_id.
- Times: 24h HH:mm, mapped to the OFFERED showtimes when choosing one.
- Do not invent values the user did not express.
"""

_SEAT = re.compile(r"^[A-Z]{1,2}\d{1,3}$")
_TICKET = re.compile(r"\bTKT-[A-Z0-9-]{4,40}\b", re.IGNORECASE)
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _match_category(value: Any, categories: List[str]) -> Any:
    wanted = str(value or "").strip().lower().rstrip("s")
    return next((c for c in categories if c.lower().rstrip("s") == wanted), None)


def validate(update: StateUpdate, context: Dict[str, Any], query: str) -> Dict[str, Any]:
    """Deterministic checks: ids must be known, values well-formed, categories real."""
    known_ids = {e["id"] for e in context["known_events"]}
    categories = context.get("catalog_categories") or []
    entities = update.model_dump()

    if entities.get("event_id") not in known_ids:
        if entities.get("event_id"):
            logger.info("Dropping event_id %r not present in known events", entities["event_id"])
        entities["event_id"] = None

    spec = entities.get("search")
    if spec:
        spec["reject_event_ids"] = [i for i in spec.get("reject_event_ids") or [] if i in known_ids]
        if spec.get("category"):
            real = _match_category(spec["category"], categories)
            if real:
                spec["category"] = real
            else:
                # Not a catalog category (e.g. "horror"): keep it as a genre instead of matching nothing.
                spec["genre"] = spec.get("genre") or spec["category"]
                spec["category"] = None
        spec["exclude_categories"] = [c for c in (_match_category(x, categories) for x in spec.get("exclude_categories") or []) if c]
        for key in ("date_from", "date_to"):
            if spec.get(key) and not _DATE.match(spec[key]):
                spec[key] = None

    entities["seats"] = [s for s in (str(x).upper().replace(" ", "") for x in entities.get("seats") or []) if _SEAT.match(s)]
    match = _TICKET.search(entities.get("ticket_id") or "") or _TICKET.search(query)
    entities["ticket_id"] = match.group(0).upper() if match else None
    if entities.get("time") and not _TIME.match(entities["time"]):
        entities["time"] = None
    if entities.get("date") and not _DATE.match(entities["date"]):
        entities["date"] = None
    q = entities.get("quantity")
    entities["quantity"] = q if isinstance(q, int) and 0 < q <= 50 else None
    return entities


async def track(standalone: str, query: str, state: Dict[str, Any], facets: Dict[str, Any]) -> Dict[str, Any]:
    """Returns {intent, confidence, entities}. Raises LLMUnavailable when the model cannot be used."""
    context = tracker_context(state, facets)
    payload = json.dumps(
        {
            "CONTEXT": context,
            "RECENT_TURNS": recent_turns(state.get("messages") or [], limit=2),
            "LATEST_MESSAGE": query,
            "STANDALONE_REQUEST": standalone,
        },
        ensure_ascii=False,
        default=str,
    )
    update = await llm.extract(StateUpdate, SYSTEM_PROMPT, payload)
    return {"intent": update.intent, "confidence": float(update.confidence), "entities": validate(update, context, query)}
