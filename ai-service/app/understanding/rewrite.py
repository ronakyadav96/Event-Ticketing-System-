"""Step 1: rewrite the latest message into one self-contained English request."""

import json
import re
from typing import Any, Dict

from app import llm
from app.understanding.context import recent_turns, rewrite_context
from app.understanding.schemas import Rewrite
from config import settings

SYSTEM_PROMPT = """You are the first step of "Event AI", the assistant of an event & movie ticket booking platform.
Rewrite the user's LATEST message into ONE self-contained request in plain English, so that it can be
understood WITHOUT the conversation. Users write in English or Hinglish (Hindi in Roman script, mixed with English).

HOW TO REWRITE
- Translate Hinglish to English: "dikhao" = show, "aur" = more, "koi/kuch" = any/some, "wala" = the one / kind,
  "doosra/dusra" = second or another, "pehla" = first, "kal" = tomorrow (or yesterday from context), "aaj" = today,
  "sasta" = cheap, "batao" = tell me, "chahiye" = I want, "nahi" = not, "alag" = different, "type ka" = kind of.
- Resolve references with CONTEXT and RECENT_TURNS:
  * "another / more / aur dikhao / kuch aur" right after a result list → "Show more results of the same search
    (<what was searched>), not the ones already shown."
  * "other type / different kind / kuch alag type ka / aur koi category" → "Show a different kind of event than
    <CONTEXT.last_search.shown_categories>."
  * "the second one / doosra wala / pehle wala" → the event title at that position of CONTEXT.last_results.
  * "it / this / that one / ye wala" → CONTEXT.focus_event, or the event the conversation was just about.
  * Constraints added to an existing search ("sirf kal wale", "under 500", "in Bandra") → keep the previous
    search and add the constraint, e.g. "Show comedy events, only tomorrow."
- Booking steps: when CONTEXT.booking.stage is not IDLE and the message answers the current step, keep it short
  and literal: "2 tickets", "Seats A3 and A4", "The 7:30 PM show", "Yes, confirm the booking", "Cancel this booking draft".
- Keep event titles, names, ticket IDs (TKT-...) and numbers exactly as written. Never add facts, events, prices or
  dates that the user or the conversation did not mention.

SCOPE
- events: anything about events, movies, shows, tickets, seats, bookings, payments, cancellations, refunds,
  platform policies, or this assistant's abilities — including short follow-ups in an ongoing conversation.
- small_talk: only greetings, thanks, goodbyes, "how are you" — with no request in it.
- out_of_domain: anything else (general knowledge, coding, homework, news, personal advice, ...), even if polite.

EXAMPLES (context abbreviated)
- last search: all events, shown_categories [Movie] | "show me another" → "Show more events from the same search, not the ones already shown." (events)
- shown_categories [Movie] | "kuch alag type ka dikhao" → "Show events of a different kind than Movie." (events, hinglish)
- "koi movie dikhao" → "Show me some movies." (events, hinglish)
- "comedy wala kuch hai?" → "Are there any comedy events?" (events, hinglish)
- last_results [1 Minions, 2 Interstellar] | "doosre wale ke baare me batao" → "Tell me about Interstellar." (events, hinglish)
- last search comedy | "sirf kal wale" → "Show comedy events happening tomorrow." (events, hinglish)
- focus Interstellar | "iske 2 ticket book karo" → "Book 2 tickets for Interstellar." (events, hinglish)
- "mera refund kab aayega" → "What is the status of my refund?" (events, hinglish)
- "thanks bhai" → "Thanks." (small_talk, hinglish)
- "python me loop kaise likhte hai" → "How do I write a loop in Python?" (out_of_domain, hinglish)
"""


_HINGLISH = re.compile(
    r"\b(hai|hain|kya|koi|kuch|dikhao|dikha|batao|chahiye|mujhe|wala|wali|wale|nahi|nahin|aur|kal|aaj|kaise|kab|"
    r"bhai|yaar|accha|acha|theek|haan|karo|kar do|dena|milega|sasta|abhi)\b",
    re.I,
)


def guess_language(query: str) -> str:
    return "hinglish" if _HINGLISH.search(query) else "english"


def needs_rewrite(state: Dict[str, Any]) -> bool:
    """With no earlier turns and no open search/booking there is nothing to resolve: skip the call."""
    if recent_turns(state.get("messages") or []):
        return True
    search = state.get("search") or {}
    booking = state.get("booking") or {}
    return bool(search.get("last_results") or search.get("focus") or booking.get("event"))


async def rewrite(query: str, state: Dict[str, Any]) -> Rewrite:
    """Raises LLMUnavailable when the model cannot be used."""
    payload = json.dumps(
        {
            "CONTEXT": rewrite_context(state),
            "RECENT_TURNS": recent_turns(state.get("messages") or []),
            "LATEST_MESSAGE": query,
        },
        ensure_ascii=False,
        default=str,
    )
    # A single model: if it fails the pipeline simply continues with the raw message.
    result = await llm.extract(
        Rewrite, SYSTEM_PROMPT, payload, models=[settings.GEMINI_MODEL_REWRITE], timeout=settings.GEMINI_TIMEOUT_SECONDS
    )
    if not result.standalone.strip():
        result.standalone = query
    return result
