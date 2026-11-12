"""
Deterministic understanding that does not need the model.

- fast_classify: the chat UI's own buttons and pickers send fixed phrases ("Book <title>",
  "Tell me more about <title>", "Show me more", an offered showtime). When such a phrase is
  unambiguous it is resolved directly: instant, and independent of model availability.
- degraded_classify: used only when the model is unavailable. Handles unambiguous inputs
  (booking step values, yes/no, ticket IDs, greetings, plain English/Hinglish searches).
  Everything else is UNKNOWN so the user gets an honest answer instead of a guess.
"""

import re
from datetime import timedelta
from typing import Any, Dict, Optional

from app.agents.common import fmt_date, fmt_time
from app.graph.state import BookingStage, Intent, RefundStage
from app.tools.catalog import MOVIE_GENRES
from app.understanding.context import today


def _entities(**extra: Any) -> Dict[str, Any]:
    entities: Dict[str, Any] = {"seats": [], "search": None, "cancel_draft": False, "payment_check": False}
    entities.update(extra)
    return entities


def search_spec(action: str = "NEW", **filters: Any) -> Dict[str, Any]:
    spec: Dict[str, Any] = {"action": action, "exclude_categories": [], "reject_event_ids": []}
    spec.update({k: v for k, v in filters.items() if v not in (None, "", [])})
    return spec


# ── Fast path ─────────────────────────────────────────────────────────────────

_BOOK_PHRASE = re.compile(r"^\s*(?:book|reserve)\s+(?:tickets?\s+(?:for|to)\s+)?(.+?)\s*[.!]?\s*$", re.I)
_DETAILS_PHRASE = re.compile(r"^\s*(?:tell\s+me\s+(?:more\s+)?about|details\s+(?:of|for|about)|more\s+about)\s+(.+?)\s*[.?!]?\s*$", re.I)
_SHOW_MORE = re.compile(r"^\s*(?:show\s+(?:me\s+)?)?more(?:\s+(?:results|options|events|movies))?\s*[.!]?\s*$", re.I)
_SHOW_CATEGORY = re.compile(r"^\s*show\s+me\s+(.+?)\s*[.!]?\s*$", re.I)
_GENRE_MOVIES = re.compile(r"^(.+?)\s+movies?$", re.I)
# A greeting with nothing else in it; answered with the fixed short welcome.
PURE_GREETING = re.compile(
    r"^\s*(hi+|hii+|hello+|hey+|hola|namaste|namaskar|good\s+(morning|afternoon|evening)|yo|sup)"
    r"(\s+(there|tamasha|tamasha\s+ai|bot|bhai|buddy))?\s*[!.👋🙏]*\s*$",
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


def _has_search(state: Dict[str, Any]) -> bool:
    search = state.get("search") or {}
    return bool(search.get("filters") or search.get("seen") or search.get("mix"))


def fast_classify(query: str, state: Dict[str, Any], facets: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    stage = (state.get("booking") or {}).get("stage", BookingStage.IDLE.value)
    idle = stage in (BookingStage.IDLE.value, BookingStage.COMPLETED.value)

    def result(intent: Intent, **extra: Any) -> Dict[str, Any]:
        return {"intent": intent.value, "confidence": 1.0, "entities": _entities(**extra), "source": "rule"}

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
    if PURE_GREETING.match(query):
        return result(Intent.SMALL_TALK)
    if _SHOW_MORE.match(query) and idle and _has_search(state):
        return result(Intent.EVENT_SEARCH, search=search_spec("MORE"))
    # Category quick replies ("Show me Comedy") name a real catalog category exactly.
    m = _SHOW_CATEGORY.match(query)
    if m and idle:
        wanted = m.group(1).strip().lower()
        category = next((c for c in facets.get("categories") or [] if c.lower() == wanted), None)
        if category:
            return result(Intent.EVENT_SEARCH, search=search_spec("NEW", category=category))
        # Genre quick replies ("Show me Action movies") from the kind picker.
        g = _GENRE_MOVIES.match(wanted)
        if g:
            genre = next((x for x in MOVIE_GENRES if x.lower() == g.group(1).strip()), None)
            movie = next((c for c in facets.get("categories") or [] if c.lower() == "movie"), "Movie")
            if genre:
                return result(Intent.EVENT_SEARCH, search=search_spec("NEW", category=movie, genre=genre))
    return None


# ── Degraded mode (model unavailable) ─────────────────────────────────────────

_TICKET = re.compile(r"\bTKT-[A-Z0-9-]{4,40}\b", re.IGNORECASE)
_YES = re.compile(r"^\s*(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go ahead|proceed|do it|book it|haan|ha|han|theek hai|thik hai|kar do)\b", re.I)
_NO = re.compile(r"^\s*(no|nope|nah|don't|do not|keep it|stop|nahi|nahin|mat)\b", re.I)
_POLICY = re.compile(r"\b(policy|policies|how\s+(do|does|can)\b.*\b(refund|cancel)|payment\s+methods?|parking|outside\s+food|id\s+proof|age\s+limit)", re.I)
_CHANGE_TYPE = re.compile(r"\b(other|different|another|alag|dusr[aei]|doosr[aei])\s+(types?|kinds?|categor(y|ies)|tarah)\b|\btype\s+ka\b|\bkuch\s+alag\b|\bnot\s+movies\b", re.I)
_MORE = re.compile(r"\b(another|more|different|something\s+else|other|next|aur|dusr[aei]|doosr[aei]|agl[aei])\b", re.I)
_SEARCH_WORDS = re.compile(r"\b(show|find|search|browse|list|upcoming|events?|what'?s\s+on|playing|dikhao|dikha|batao|chahiye)\b", re.I)
_GREETING = re.compile(r"^\s*(hi+|hello|hey|namaste|good\s+(morning|afternoon|evening)|thanks|thank you|shukriya|how are you|kaise ho)\b", re.I)
_GENRES = (
    "action", "adventure", "animation", "animated", "comedy", "crime", "documentary", "drama", "family",
    "fantasy", "history", "horror", "music", "musical", "mystery", "romance", "romantic", "sci-fi",
    "science fiction", "thriller", "war", "western", "standup", "stand-up",
)
# Sentences that are conversation, not a name: never treated as a title search in degraded mode.
_CHATTY = re.compile(r"\b(tell|story|joke|why|how|who|explain|write|meaning|weather|news|poem|recipe|kahani|kyun|kaise)\b", re.I)
_FILLER = {
    # English
    "a", "an", "the", "me", "my", "i", "want", "wanna", "to", "watch", "see", "go", "for", "of", "some", "any",
    "please", "pls", "plz", "can", "you", "could", "would", "like", "show", "shows", "find", "search", "browse",
    "list", "upcoming", "event", "events", "movie", "movies", "film", "films", "what", "whats", "what's", "is",
    "are", "on", "playing", "in", "at", "near", "tonight", "today", "this", "weekend", "good", "best", "new",
    "latest", "all", "available", "tickets", "ticket", "book", "get", "with", "and", "or", "about", "info",
    "information", "details", "tell", "more", "there", "do", "have", "something", "let", "us", "lets",
    "another", "other", "else", "different", "type", "types", "kind", "kinds", "next", "one", "ones",
    # Hinglish
    "koi", "kuch", "dikhao", "dikha", "dikhana", "do", "de", "dena", "batao", "bata", "wala", "wali", "wale",
    "hai", "hain", "kya", "aur", "bhi", "mujhe", "muje", "humko", "hume", "chahiye", "ka", "ki", "ke", "ko",
    "se", "mein", "me", "par", "pe", "ek", "dusra", "dusri", "dusre", "doosra", "doosri", "doosre", "alag",
    "accha", "acha", "achha", "badhiya", "bro", "bhai", "yaar", "na", "toh", "to", "kal", "aaj", "abhi",
    "picture", "filmein", "tarah", "naya", "nayi", "naye", "sab", "saare", "sare", "liye", "dekhna", "dekhni",
    "dekhne", "kar", "karo", "sakta", "sakte", "milega", "milegi", "raha", "rahi", "rahe", "hoga", "hogi",
}


_ORDINALS = {
    1: r"first|1st|pehl[aei]|pahl[aei]", 2: r"second|2nd|dusr[aei]|doosr[aei]", 3: r"third|3rd|teesr[aei]|tisr[aei]",
    4: r"fourth|4th|chauth[aei]", 5: r"fifth|5th|paanchv[aei]|panchv[aei]",
}
_ABOUT = re.compile(r"\b(about|details?|tell|baare|batao|bata|info|kya hai|kaisi|kaisa)\b", re.I)
_PRICE = re.compile(r"\b(?:under|below|less than|upto|up to|within)\s*(?:rs\.?|₹)?\s*(\d{2,5})\b|\b(?:rs\.?|₹)?\s*(\d{2,5})\s*(?:se\s+kam|tak|ke\s+andar|or\s+less)\b", re.I)
_DATE_WORDS = {"today", "aaj", "tomorrow", "kal", "weekend", "tonight", "sirf", "only", "rs", "under", "below", "kam", "tak"}


def _ordinal(ql: str) -> Optional[int]:
    for n, pattern in _ORDINALS.items():
        if re.search(rf"\b({pattern})\b", ql):
            return n
    return None


def _date_filters(ql: str) -> Dict[str, Any]:
    day0 = today().date()
    if re.search(r"\b(today|aaj|tonight)\b", ql):
        day = day0
    elif re.search(r"\b(tomorrow|kal)\b", ql):
        day = day0 + timedelta(days=1)
    elif re.search(r"\bweekend\b", ql):
        saturday = day0 + timedelta(days=(5 - day0.weekday()) % 7)
        return {"date_from": saturday.isoformat(), "date_to": (saturday + timedelta(days=1)).isoformat()}
    else:
        return {}
    return {"date_from": day.isoformat(), "date_to": day.isoformat()}


def degraded_classify(query: str, state: Dict[str, Any], facets: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    q = query.strip()
    ql = q.lower()
    booking = state.get("booking") or {}
    refund = state.get("refund") or {}
    stage = booking.get("stage", BookingStage.IDLE.value)
    options = booking.get("options") or {}

    def result(intent: Intent, **extra: Any) -> Dict[str, Any]:
        return {"intent": intent.value, "confidence": 0.5, "entities": _entities(**extra), "source": "degraded"}

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
            day0 = today().date()
            wanted = {"today": day0, "aaj": day0, "tomorrow": day0 + timedelta(days=1), "kal": day0 + timedelta(days=1)}
            for word, day in wanted.items():
                if re.search(rf"\b{word}\b", ql) and day.isoformat() in dates:
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

    # "the second one" / "doosra wala" → that position of the last result list.
    position = _ordinal(ql)
    last = (state.get("search") or {}).get("last_results") or []
    if position and position <= len(last) and _ABOUT.search(ql):
        return result(Intent.EVENT_DETAILS, event_id=last[position - 1])

    # Plain searches: map words onto the catalog's real categories (no hardcoded titles).
    date_filters = _date_filters(ql)
    price = _PRICE.search(ql)
    max_price = float(price.group(1) or price.group(2)) if price else None
    ql_terms = _PRICE.sub(" ", ql)
    words = set(re.findall(r"[a-z]+", ql))
    category = None
    for cat in (facets or {}).get("categories") or []:
        stem = cat.lower().rstrip("s")
        if any(w == cat.lower() or w.rstrip("s") == stem or (len(stem) > 4 and w.startswith(stem[:5])) for w in words):
            category = cat
            break
    genre = next((g for g in _GENRES if re.search(rf"\b{re.escape(g)}\b", ql)), None)
    if genre and category and genre.rstrip("s") == category.lower().rstrip("s"):
        genre = None  # "comedy events": Comedy is the category itself
    # Whatever is left after removing filler, category and genre words is a title / name / topic.
    used = set(re.findall(r"[a-z]+", (genre or "") + " " + (category or "").lower()))
    leftover = [w for w in re.findall(r"[a-z0-9']+", ql_terms) if w not in _FILLER and w not in used and w not in _DATE_WORDS
                and not (category and w.rstrip("s") == category.lower().rstrip("s"))]
    text = " ".join(leftover) if leftover else None

    constraints = {**date_filters, "max_price": max_price}
    if idle and _has_search(state) and not (category or genre or text):
        if any(constraints.values()):
            # "sirf kal wale" / "under 500": narrow the current search.
            return result(Intent.EVENT_SEARCH, search=search_spec("REFINE", **constraints))
        if _CHANGE_TYPE.search(ql):
            return result(Intent.EVENT_SEARCH, search=search_spec("CHANGE_TYPE"))
        if _MORE.search(ql):
            return result(Intent.EVENT_SEARCH, search=search_spec("MORE"))
    # Anything short that is not chit-chat is most likely an event, movie or artist name.
    if category or genre or text or any(constraints.values()) or _SEARCH_WORDS.search(ql):
        if text and (len(leftover) > 6 or _CHATTY.search(ql)):
            if not (category or genre):
                return result(Intent.UNKNOWN)
            text = None
        return result(Intent.EVENT_SEARCH, search=search_spec("NEW", category=category, genre=genre, text=text, **constraints))
    return result(Intent.UNKNOWN)
