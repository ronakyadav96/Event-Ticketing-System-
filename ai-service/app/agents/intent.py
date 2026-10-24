"""
The single, authoritative intent classification path.

classify() asks Model 1 for a structured Extraction using the conversation context
(booking stage and offered options, events already shown, pending refund decision,
recent turns). The result is then validated deterministically: references must point
at events the user has actually seen, seats/tickets/times must be well-formed.

If Model 1 is unavailable, a small *explicitly designed* degraded mode handles only
unambiguous inputs (slot values for the current booking step, yes/no to a pending
question, ticket IDs, greetings). Everything else is reported as UNKNOWN so the user
gets an honest "temporarily unavailable" answer instead of a guess.
"""

import json
import logging
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Literal, Optional
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from app.agents.common import fmt_date, fmt_time
from app.agents.vocab import find_category, find_topic, normalize_search
from app.graph.state import BookingStage, Intent, RefundStage
from app.llm import LLMUnavailable, extract
from config import settings

logger = logging.getLogger(__name__)

IntentName = Literal[
    "EVENT_SEARCH", "EVENT_DETAILS", "BOOKING", "BOOKING_STATUS", "REFUND", "REFUND_STATUS",
    "CANCEL_BOOKING", "FAQ_POLICY", "SMALL_TALK", "OUT_OF_DOMAIN", "UNKNOWN",
]


class SearchEntities(BaseModel):
    text: Optional[str] = Field(None, description="Keywords to match in titles/descriptions: a full or partial title, performer, or topic (e.g. 'dark knight', 'space travel'). Never genre or category words.")
    category: Optional[str] = Field(None, description="Event category, chosen from the catalog categories when one applies (e.g. Movie, Concert, Comedy).")
    genre: Optional[str] = Field(None, description="Genre / style the user asked for, e.g. comedy, science fiction, rock.")
    venue: Optional[str] = Field(None, description="Venue or theatre name the user asked for (NOT a city).")
    city: Optional[str] = Field(None, description="City the user asked for, copied from CONTEXT.catalog_cities when possible (e.g. 'comedy in Pune' → Pune). Leave empty if no city was named.")
    date_from: Optional[str] = Field(None, description="Earliest date YYYY-MM-DD.")
    date_to: Optional[str] = Field(None, description="Latest date YYYY-MM-DD.")
    max_price: Optional[float] = Field(None, description="Maximum ticket price in rupees.")
    more_results: bool = Field(False, description="True ONLY when the user wants more results of the SAME previous search ('show me another', 'more', 'something else', 'different one'). False when they ask for a new title, genre, category or venue.")
    reject_event_ids: List[str] = Field(default_factory=list, description="IDs of known events the user rejected ('not this one').")


class Extraction(BaseModel):
    intent: IntentName
    confidence: float = Field(..., ge=0.0, le=1.0)
    language: Literal["en", "hi"] = Field("en", description="'hi' if the user writes Hinglish/Hindi (Roman or Devanagari script), 'en' for English. For short neutral messages (a title, a number, 'yes') use the language of the user's previous messages.")
    event_id: Optional[str] = Field(None, description="ID of the event the user refers to. MUST be copied from KNOWN EVENTS; never invent IDs.")
    event_title: Optional[str] = Field(None, description="Event title the user named when it is not in KNOWN EVENTS.")
    search: Optional[SearchEntities] = None
    venue_choice: Optional[str] = Field(None, description="Venue picked from the offered venue options (copy it exactly).")
    date: Optional[str] = Field(None, description="Show date YYYY-MM-DD picked by the user (resolve 'today', 'tomorrow', weekdays).")
    time: Optional[str] = Field(None, description="Show time picked by the user as 24h HH:mm.")
    quantity: Optional[int] = Field(None, description="Number of tickets requested.")
    seats: List[str] = Field(default_factory=list, description="Seat IDs such as A1, B12.")
    confirmation: Optional[bool] = Field(None, description="True = explicit yes/confirm to the pending question, False = explicit no/decline, null otherwise.")
    cancel_draft: bool = Field(False, description="True when the user wants to abandon the booking currently in progress.")
    ticket_id: Optional[str] = Field(None, description="Ticket ID such as TKT-... if mentioned.")
    payment_check: bool = Field(False, description="True when the user says they paid or asks whether payment went through.")


SYSTEM_PROMPT = """You are the query-understanding component of an Event & Movie ticket booking assistant in India.
Classify the user's LATEST message using the conversation CONTEXT, and extract entities.
Users write in English or Hinglish (Hindi in Roman letters, e.g. "comedy shows dikhao", "kal koi concert hai kya",
"is weekend kuch funny", "mujhe 2 ticket chahiye") and sometimes Hindi in Devanagari. Understand all of them.

INTENTS
- EVENT_SEARCH: find/browse events or movies, including follow-ups like "show me another", "more options", "something else", "show me science fiction".
- EVENT_DETAILS: information about one specific event ("tell me more about X", "what is the second one about", "where is it playing").
- BOOKING: start or continue booking tickets: choosing an event to book, venue, date, showtime, number of tickets, seats, confirming the summary, payment progress ("I paid", "did my payment go through"), or abandoning the booking in progress.
- BOOKING_STATUS: status of the user's existing bookings / tickets.
- CANCEL_BOOKING: cancel an existing, already paid booking/ticket.
- REFUND: ask for money back for an existing booking.
- REFUND_STATUS: status of a refund already requested.
- FAQ_POLICY: questions about rules and policies (refund/cancellation policy, payment methods, entry rules, ID, food, parking, support).
- SMALL_TALK: greetings, thanks, how are you, what can you do.
- OUT_OF_DOMAIN: anything unrelated to events, movies, tickets, bookings or this platform.
- UNKNOWN: unintelligible.

RULES
- Use CONTEXT. If a booking is in progress and the message answers the current step (a time, a number, seat IDs, "yes"), it is BOOKING.
- A yes/no answering a pending cancellation/refund question is CANCEL_BOOKING (or REFUND) with confirmation set.
- "Cancel" while a booking is in progress and no ticket ID is mentioned means abandoning that draft: BOOKING with cancel_draft=true.
- Asking how cancellation or refunds work in general is FAQ_POLICY, not CANCEL_BOOKING.
- A request for a new title, genre, category, venue or topic is a NEW search: fill the new filters (do not copy LAST_SEARCH_FILTERS) and leave more_results false. Use more_results for 'another / more / something else' without new criteria.
- event_id must be copied from KNOWN EVENTS. Ordinals ("the second one") refer to the positions of the LAST RESULTS list. If the user names an event that is not in KNOWN EVENTS, set event_title instead.
- reject_event_ids: only events the user named, or the focus event when they say "not this one". If it is unclear which event "this one" is, leave it empty.
- Never pick an event the user did not refer to. If unsure which event, leave event_id empty.
- When CONTEXT.refund.options lists ticket IDs and the user picks one (by ID or position), copy that ID into ticket_id.
- Dates: resolve relative to TODAY. Times: 24h HH:mm; map to the OFFERED showtimes when the user is choosing one.
- Do not invent values the user did not express.

SEARCH MAPPING
- Use CONTEXT.catalog_categories for search.category. Map synonyms: funny / hasi / stand-up / jokes / open mic → Comedy;
  music / gaana / concert / gig / DJ / band → Concert; cricket / football / IPL / match / marathon / khel → Sports;
  natak / theatre / drama / play → Plays; workshop / class / sikhna → Workshop; talk / seminar / conference → Seminar;
  yoga / camping / trek / adventure → Activities; movie / film / picture / cinema → Movie.
- "events", "shows", "kuch karne ko" with no type means live events: leave category and text empty.
- A specific sport / artist / title goes in search.text (e.g. "cricket", "samay raina", "dark knight").
- For movies, the style goes in genre (comedy, action, horror, romance...), category = Movie.
- Hindi time words: aaj = today, kal = tomorrow (in a search), parso = day after tomorrow,
  "is weekend" / "weekend pe" = the coming Saturday–Sunday. "500 se kam" / "under 500" → max_price 500.
- A city ("in Pune", "Delhi me", "Bangalore mein") goes in search.city, never in venue.
"""


def _today(tz: ZoneInfo) -> datetime:
    return datetime.now(tz)


def build_context(state: Dict[str, Any], facets: Dict[str, Any]) -> Dict[str, Any]:
    """Compact, model-facing view of everything the classifier may rely on."""
    search = state.get("search") or {}
    booking = state.get("booking") or {}
    refund = state.get("refund") or {}
    catalog = search.get("catalog") or {}
    last = search.get("last_results") or []

    known = []
    for eid, ev in catalog.items():
        entry = {"id": eid, "title": ev.get("title"), "category": ev.get("category"), "venue": ev.get("venue")}
        if eid in last:
            entry["last_results_position"] = last.index(eid) + 1
        known.append(entry)

    booking_ctx: Dict[str, Any] = {"stage": booking.get("stage", BookingStage.IDLE.value)}
    if booking.get("event"):
        booking_ctx["event"] = {"id": booking["event"].get("id"), "title": booking["event"].get("title")}
    offered = (booking.get("options") or {})
    for key in ("venues", "dates", "times", "max_quantity", "suggested_seats"):
        if offered.get(key):
            booking_ctx[f"offered_{key}"] = offered[key]

    tz = ZoneInfo(settings.EVENT_TIMEZONE)
    return {
        "today": _today(tz).strftime("%Y-%m-%d (%A)"),
        "catalog_categories": facets.get("categories") or [],
        "catalog_cities": facets.get("cities") or [],
        "selected_city": state.get("city"),
        "known_events": known[-40:],
        "focus_event_id": search.get("focus"),
        "last_search_filters": search.get("filters") or {},
        "booking": booking_ctx,
        "refund": {
            "stage": refund.get("stage", RefundStage.IDLE.value),
            "ticket_id": refund.get("ticket_id"),
            "options": refund.get("options") or [],
        },
    }


def _recent_turns(messages: List[Any], limit: int = 6) -> List[Dict[str, str]]:
    turns = []
    for m in messages[-(limit + 1):-1]:
        role = "user" if getattr(m, "type", "") == "human" else "assistant"
        turns.append({"role": role, "text": str(getattr(m, "content", ""))[:400]})
    return turns


# ── Deterministic validation of Model 1 output ─────────────────────────────────

_SEAT = re.compile(r"^[A-Z]{1,2}\d{1,3}$")
_TICKET = re.compile(r"\bTKT-[A-Z0-9-]{4,40}\b", re.IGNORECASE)
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate(ex: Extraction, context: Dict[str, Any], query: str) -> Dict[str, Any]:
    known_ids = {e["id"] for e in context["known_events"]}
    entities = ex.model_dump()

    if entities.get("event_id") not in known_ids:
        if entities.get("event_id"):
            logger.info("Dropping event_id %r not present in known events", entities["event_id"])
        entities["event_id"] = None
    if entities.get("search"):
        entities["search"]["reject_event_ids"] = [i for i in entities["search"].get("reject_event_ids") or [] if i in known_ids]

    entities["seats"] = [s for s in (str(x).upper().replace(" ", "") for x in entities.get("seats") or []) if _SEAT.match(s)]
    ticket = entities.get("ticket_id") or ""
    match = _TICKET.search(ticket) or _TICKET.search(query)
    entities["ticket_id"] = match.group(0).upper() if match else None
    if entities.get("time") and not _TIME.match(entities["time"]):
        entities["time"] = None
    if entities.get("date") and not _DATE.match(entities["date"]):
        entities["date"] = None
    q = entities.get("quantity")
    entities["quantity"] = q if isinstance(q, int) and 0 < q <= 50 else None
    return entities


# ── Deterministic fast path ───────────────────────────────────────────────────
# The chat UI's own buttons send fixed phrases ("Book <title>", "Tell me more about <title>",
# "Show me more"). When such a phrase names an event already shown in this conversation it is
# unambiguous, so it is resolved directly: instant, and independent of model availability.

_BOOK_PHRASE = re.compile(r"^\s*(?:book|reserve)\s+(?:tickets?\s+(?:for|to)\s+)?(.+?)\s*[.!]?\s*$", re.I)
_DETAILS_PHRASE = re.compile(r"^\s*(?:tell\s+me\s+(?:more\s+)?about|details\s+(?:of|for|about)|more\s+about)\s+(.+?)\s*[.?!]?\s*$", re.I)
_SHOW_MORE = re.compile(
    r"^\s*(?:(?:show\s+(?:me\s+)?)?more(?:\s+(?:results|options|events|movies|shows))?"
    r"|(?:aur|or|more)\s+(?:dikhao|dikha\s*do|batao|chahiye|options)|aur\s+koi|next)\s*[.!]?\s*$",
    re.I,
)


def _known_by_title(state: Dict[str, Any], title: str) -> Optional[str]:
    """ID of the single known event with exactly this title (most recently shown wins on ties)."""
    search = state.get("search") or {}
    wanted = title.strip().lower()
    matches = [eid for eid, ev in (search.get("catalog") or {}).items() if (ev.get("title") or "").strip().lower() == wanted]
    if not matches:
        return None
    last = search.get("last_results") or []
    in_last = [eid for eid in matches if eid in last]
    return (in_last or matches)[-1]


def fast_classify(query: str, state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    stage = (state.get("booking") or {}).get("stage", BookingStage.IDLE.value)
    idle = stage in (BookingStage.IDLE.value, BookingStage.COMPLETED.value)
    search = state.get("search") or {}

    def result(intent: Intent, **extra: Any) -> Dict[str, Any]:
        entities: Dict[str, Any] = {"seats": [], "search": None, "cancel_draft": False, "payment_check": False}
        entities.update(extra)
        return {"intent": intent.value, "confidence": 1.0, "entities": entities, "source": "rule"}

    # A booking step answered with exactly one of the offered options (the UI's option picker).
    options = (state.get("booking") or {}).get("options") or {}
    picked = query.strip().lower()
    if stage == BookingStage.SELECT_VENUE.value:
        venue = next((v for v in options.get("venues") or [] if v.strip().lower() == picked), None)
        if venue:
            return result(Intent.BOOKING, venue_choice=venue)
    if stage == BookingStage.SELECT_DATE.value:
        date = next((d for d in options.get("dates") or [] if picked in (d, fmt_date(d).lower())), None)
        if date:
            return result(Intent.BOOKING, date=date)
    if stage == BookingStage.SELECT_SHOWTIME.value:
        time = next((t for t in options.get("times") or [] if picked in (t, fmt_time(t).lower())), None)
        if time:
            return result(Intent.BOOKING, time=time)
    if stage == BookingStage.SELECT_QUANTITY.value:
        qty = re.fullmatch(r"(\d{1,2})(?:\s*(?:tickets?|seats?))?", picked)
        if qty and 1 <= int(qty.group(1)) <= int(options.get("max_quantity") or 10):
            return result(Intent.BOOKING, quantity=int(qty.group(1)))
    if stage == BookingStage.SELECT_SEATS.value:
        seats = re.fullmatch(r"(?:seats?\s+)?([a-z]{1,2}\d{1,3}(?:\s*,\s*[a-z]{1,2}\d{1,3})*)", picked)
        if seats:
            return result(Intent.BOOKING, seats=[x.strip().upper() for x in seats.group(1).split(",")])

    m = _BOOK_PHRASE.match(query)
    if m and idle:
        event_id = _known_by_title(state, m.group(1))
        if event_id:
            return result(Intent.BOOKING, event_id=event_id)
    m = _DETAILS_PHRASE.match(query)
    if m:
        event_id = _known_by_title(state, m.group(1))
        if event_id:
            return result(Intent.EVENT_DETAILS, event_id=event_id)
    if _SHOW_MORE.match(query) and idle and (search.get("filters") or search.get("seen")):
        return result(Intent.EVENT_SEARCH, search={"more_results": True, "reject_event_ids": []})
    return None


async def classify(query: str, state: Dict[str, Any], facets: Dict[str, Any]) -> Dict[str, Any]:
    """Returns {intent, confidence, entities, source}."""
    result = await _classify(query, state, facets)
    spec = result["entities"].get("search")
    if result["intent"] == Intent.EVENT_SEARCH.value and spec and not spec.get("more_results"):
        result["entities"]["search"] = normalize_search(spec, query, facets)
    return result


async def _classify(query: str, state: Dict[str, Any], facets: Dict[str, Any]) -> Dict[str, Any]:
    fast = fast_classify(query, state)
    if fast:
        return fast
    context = build_context(state, facets)
    user_payload = json.dumps(
        {"CONTEXT": context, "RECENT_TURNS": _recent_turns(state.get("messages") or []), "LATEST_MESSAGE": query},
        ensure_ascii=False,
        default=str,
    )
    try:
        ex = await extract(Extraction, SYSTEM_PROMPT, user_payload)
        entities = _validate(ex, context, query)
        return {"intent": ex.intent, "confidence": float(ex.confidence), "entities": entities, "source": "model"}
    except LLMUnavailable:
        return degraded_classify(query, state, facets)


# ── Degraded mode (Model 1 unavailable) ───────────────────────────────────────

_YES = re.compile(r"^\s*(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go ahead|proceed|do it|book it|haan|haa|ha|ji|theek|thik|chalo|kar\s*do|book\s*karo)\b", re.I)
_NO = re.compile(r"^\s*(no|nope|nah|don't|do not|keep it|stop|nahi|nhi|mat|rehne\s+do)\b", re.I)
_POLICY = re.compile(
    r"\b(policy|policies|rules?|niyam|how\s+(do|does|can)\b.*\b(refund|cancel)|(refund|cancel)\w*\s+(kaise|ka\s+rule|ki\s+policy)"
    r"|payment\s+methods?|parking|outside\s+food|id\s+proof|age\s+limit)",
    re.I,
)
_MORE = re.compile(r"\b(another|more|different|something\s+else|other|aur|dusra|doosra)\b", re.I)
_SEARCH_WORDS = re.compile(r"\b(show|find|search|browse|list|upcoming|events?|what'?s\s+on|playing|dikhao|dikha|batao|chahiye|koi|kuch)\b", re.I)
_GREETING = re.compile(
    r"^\s*(hi+|hello|hey|good\s+(morning|afternoon|evening)|thanks|thank you|how are you|namaste|namaskar|kaise\s+ho|kya\s+haal|shukriya|dhanyavad)\b",
    re.I,
)
_GENRES = (
    "action", "adventure", "animation", "animated", "comedy", "crime", "documentary", "drama", "family",
    "fantasy", "history", "horror", "music", "musical", "mystery", "romance", "romantic", "sci-fi",
    "science fiction", "thriller", "war", "western", "standup", "stand-up",
)
# Sentences that are conversation, not a name: never treated as a title search in degraded mode.
_CHATTY = re.compile(r"\b(tell|story|joke|why|how|who|explain|write|meaning|weather|news|poem|recipe|kahani|mausam|kyun|kyu)\b", re.I)
_FILLER = {
    "a", "an", "the", "me", "my", "i", "want", "wanna", "to", "watch", "see", "go", "for", "of", "some", "any",
    "please", "pls", "plz", "can", "you", "could", "would", "like", "show", "shows", "find", "search", "browse",
    "list", "upcoming", "event", "events", "movie", "movies", "film", "films", "what", "whats", "what's", "is",
    "are", "on", "playing", "in", "at", "near", "tonight", "today", "this", "weekend", "good", "best", "new",
    "latest", "all", "available", "tickets", "ticket", "book", "get", "with", "and", "or", "about", "info",
    "information", "details", "tell", "more", "there", "do", "have", "something", "let", "us", "lets",
    # Hinglish
    "dikhao", "dikha", "dikhado", "batao", "bata", "mujhe", "muje", "mjhe", "chahiye", "chaiye", "koi", "kuch",
    "kuchh", "hai", "hain", "kya", "aaj", "kal", "parso", "is", "weekend", "pe", "par", "me", "mein", "mai", "ke",
    "ka", "ki", "ko", "liye", "wala", "wali", "wale", "dekhna", "dekhni", "jaana", "jana", "hoga", "hogi", "abhi",
    "ye", "yeh", "bhai", "yaar", "sab", "saare", "sare", "acha", "accha", "chal", "raha", "rahe", "rahi", "near",
    "nearby", "paas", "show", "shows", "tomorrow", "week", "next", "this", "coming", "sunna", "sunne", "sunni",
    "dekhne", "karna", "karne", "khelna", "jaate", "jayein", "chalein", "plan", "tonight",
}


_PRICE = re.compile(
    r"(?:\b(?:under|below|less\s+than|within|upto|up\s+to)\s*(?:rs\.?|₹|inr)?\s*(?P<a>\d{2,6}))"
    r"|(?:(?:rs\.?|₹)?\s*(?P<b>\d{2,6})\s*(?:rs|rupees?)?\s+(?:se\s+kam|tak|ke\s+andar|or\s+less))",
    re.I,
)


def _date_window(ql: str) -> Dict[str, str]:
    """date_from / date_to for "today / aaj", "tomorrow / kal", "this weekend / is weekend"."""
    today = _today(ZoneInfo(settings.EVENT_TIMEZONE)).date()
    if re.search(r"\b(this\s+weekend|is\s+weekend|weekend)\b", ql):
        dow = today.weekday()  # Monday = 0
        sat = today if dow == 6 else today + timedelta(days=(5 - dow) % 7)
        sun = today if dow == 6 else sat + timedelta(days=1)
        return {"date_from": sat.isoformat(), "date_to": sun.isoformat()}
    if re.search(r"\b(tomorrow|kal)\b", ql):
        d = (today + timedelta(days=1)).isoformat()
        return {"date_from": d, "date_to": d}
    if re.search(r"\b(today|tonight|aaj)\b", ql):
        return {"date_from": today.isoformat(), "date_to": today.isoformat()}
    return {}


def degraded_classify(query: str, state: Dict[str, Any], facets: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    q = query.strip()
    ql = q.lower()
    booking = state.get("booking") or {}
    refund = state.get("refund") or {}
    stage = booking.get("stage", BookingStage.IDLE.value)
    options = booking.get("options") or {}
    entities: Dict[str, Any] = {"seats": [], "search": None, "cancel_draft": False, "payment_check": False}

    def result(intent: Intent, **extra: Any) -> Dict[str, Any]:
        entities.update(extra)
        return {"intent": intent.value, "confidence": 0.5, "entities": entities, "source": "degraded"}

    ticket = _TICKET.search(q)
    if refund.get("stage") == RefundStage.AWAITING_CONFIRMATION.value and not ticket:
        if _YES.search(q):
            return result(Intent.CANCEL_BOOKING, confirmation=True)
        if _NO.search(q):
            return result(Intent.CANCEL_BOOKING, confirmation=False)

    if ticket:
        tid = ticket.group(0).upper()
        if "refund" in ql and "status" in ql:
            return result(Intent.REFUND_STATUS, ticket_id=tid)
        if "cancel" in ql or "refund" in ql:
            return result(Intent.CANCEL_BOOKING, ticket_id=tid)
        return result(Intent.BOOKING_STATUS, ticket_id=tid)

    if stage != BookingStage.IDLE.value and stage != BookingStage.COMPLETED.value:
        if re.search(r"\bcancel\b", ql):
            return result(Intent.BOOKING, cancel_draft=True)
        if stage == BookingStage.SELECT_VENUE.value:
            venues = options.get("venues") or []
            num = re.fullmatch(r"\s*(\d+)\s*", q)
            if num and 1 <= int(num.group(1)) <= len(venues):
                return result(Intent.BOOKING, venue_choice=venues[int(num.group(1)) - 1])
            for v in venues:
                if v.lower() in ql or ql in v.lower():
                    return result(Intent.BOOKING, venue_choice=v)
        if stage == BookingStage.SELECT_DATE.value:
            dates = options.get("dates") or []
            tz = ZoneInfo(settings.EVENT_TIMEZONE)
            today = _today(tz).date()
            wanted = {"today": today, "tomorrow": today + timedelta(days=1)}
            for word, day in wanted.items():
                if word in ql and day.isoformat() in dates:
                    return result(Intent.BOOKING, date=day.isoformat())
            for d in dates:
                if d in q or fmt_date(d).lower() in ql:
                    return result(Intent.BOOKING, date=d)
        if stage == BookingStage.SELECT_SHOWTIME.value:
            times = options.get("times") or []
            m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", ql)
            if m:
                h, mi, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
                if ap == "pm" and h < 12:
                    h += 12
                if ap == "am" and h == 12:
                    h = 0
                hhmm = f"{h:02d}:{mi:02d}"
                if hhmm in times:
                    return result(Intent.BOOKING, time=hhmm)
        if stage == BookingStage.SELECT_QUANTITY.value:
            m = re.fullmatch(r"\s*(\d{1,2})\s*(tickets?|seats?)?\s*", ql)
            if m:
                return result(Intent.BOOKING, quantity=int(m.group(1)))
        if stage == BookingStage.SELECT_SEATS.value:
            seats = [s.upper() for s in re.findall(r"\b([A-Za-z]{1,2}\d{1,3})\b", q)]
            if seats:
                return result(Intent.BOOKING, seats=seats)
        if stage == BookingStage.REVIEW.value:
            if _YES.search(q):
                return result(Intent.BOOKING, confirmation=True)
            if _NO.search(q):
                return result(Intent.BOOKING, confirmation=False)
        if stage == BookingStage.PAYMENT_PENDING.value and re.search(r"\b(paid|payment|status|done)\b", ql):
            return result(Intent.BOOKING, payment_check=True)

    if _GREETING.search(q) and len(ql.split()) <= 4:
        return result(Intent.SMALL_TALK)

    if _POLICY.search(ql):
        return result(Intent.FAQ_POLICY)

    idle = stage in (BookingStage.IDLE.value, BookingStage.COMPLETED.value)
    m = _BOOK_PHRASE.match(q)
    if m and idle:
        target = m.group(1).strip()
        if re.fullmatch(r"(it|this|that|this one|that one|now|tickets?)", target.lower()):
            return result(Intent.BOOKING)  # the event in focus
        return result(Intent.BOOKING, event_title=target)
    m = _DETAILS_PHRASE.match(q)
    if m:
        return result(Intent.EVENT_DETAILS, event_title=m.group(1).strip())

    # Plain searches: map words onto the catalog's real categories (no hardcoded titles).
    price = _PRICE.search(ql)
    if price:
        ql = (ql[: price.start()] + " " + ql[price.end():]).strip()
    categories = (facets or {}).get("categories") or []
    topic = find_topic(ql, categories)  # "yoga classes" is about yoga, not the Workshop category
    category = topic[0] if topic else find_category(ql, categories)
    genre = next((g for g in _GENRES if re.search(rf"\b{re.escape(g)}\b", ql)), None)
    if genre and category and find_category(genre, [category]) == category:
        genre = None  # "comedy events": Comedy is the category itself
    # Whatever is left after removing filler, category and genre words is a title / name / topic.
    used = set(re.findall(r"[a-z]+", (genre or "") + " " + (category or "").lower()))
    leftover = [w for w in re.findall(r"[a-z0-9']+", ql) if w not in _FILLER and w not in used
                and not find_category(w, categories)]
    text = " ".join(leftover) if leftover else None

    wants_more = bool(_MORE.search(ql)) and bool((state.get("search") or {}).get("filters") or (state.get("search") or {}).get("seen"))
    if wants_more and not (category or genre or text):
        return result(Intent.EVENT_SEARCH, search={"more_results": True, "reject_event_ids": []})
    # Anything short that is not chit-chat is most likely an event, movie or artist name.
    dates = _date_window(ql)
    if category or genre or text or dates or _SEARCH_WORDS.search(ql):
        spec: Dict[str, Any] = {"more_results": False, "reject_event_ids": []}
        spec.update(dates)
        if price:
            spec["max_price"] = float(price.group("a") or price.group("b"))
        if category:
            spec["category"] = category
        if genre:
            spec["genre"] = genre
        if text and (len(leftover) > 6 or _CHATTY.search(ql)):
            if not (category or genre):
                return result(Intent.UNKNOWN)
        elif text:
            spec["text"] = text
        return result(Intent.EVENT_SEARCH, search=spec)
    return result(Intent.UNKNOWN)
