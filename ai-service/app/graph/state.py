"""
Conversation state persisted per (user, conversation) LangGraph thread.

Persistent sections (survive across turns via the checkpointer):
- search:  every event shown in this conversation and the last search context
- booking: the explicit booking state machine (BookingStage)
- refund:  the pending cancellation / refund decision, if any

Per-turn sections (reset at the start of every turn by the hydrate node):
- intent, entities, reply
"""

from enum import Enum
from typing import Annotated, Any, Dict, List, Optional

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict


class Intent(str, Enum):
    EVENT_SEARCH = "EVENT_SEARCH"
    EVENT_DETAILS = "EVENT_DETAILS"
    BOOKING = "BOOKING"
    BOOKING_STATUS = "BOOKING_STATUS"
    REFUND = "REFUND"
    REFUND_STATUS = "REFUND_STATUS"
    CANCEL_BOOKING = "CANCEL_BOOKING"
    FAQ_POLICY = "FAQ_POLICY"
    SMALL_TALK = "SMALL_TALK"
    OUT_OF_DOMAIN = "OUT_OF_DOMAIN"
    UNKNOWN = "UNKNOWN"


class BookingStage(str, Enum):
    IDLE = "IDLE"
    SELECT_VENUE = "SELECT_VENUE"
    SELECT_DATE = "SELECT_DATE"
    SELECT_SHOWTIME = "SELECT_SHOWTIME"
    SELECT_QUANTITY = "SELECT_QUANTITY"
    SELECT_SEATS = "SELECT_SEATS"
    REVIEW = "REVIEW"                    # summary shown, waiting for explicit confirmation
    PAYMENT_PENDING = "PAYMENT_PENDING"  # Stripe checkout created, seats LOCKED, not paid
    COMPLETED = "COMPLETED"              # Node verified payment and created the booking


# Stages where a draft booking is in progress (cancellable as a draft, not a refund).
ACTIVE_BOOKING_STAGES = {
    BookingStage.SELECT_VENUE,
    BookingStage.SELECT_DATE,
    BookingStage.SELECT_SHOWTIME,
    BookingStage.SELECT_QUANTITY,
    BookingStage.SELECT_SEATS,
    BookingStage.REVIEW,
    BookingStage.PAYMENT_PENDING,
}


class RefundStage(str, Enum):
    IDLE = "IDLE"
    SELECT_BOOKING = "SELECT_BOOKING"          # several bookings match; user must pick one
    AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"


def empty_booking() -> Dict[str, Any]:
    return {
        "stage": BookingStage.IDLE.value,
        "event": None,          # authoritative event summary (id, title, venue, price, ...)
        "venue_options": [],    # [{event_id, venue}] when the same show runs at several venues
        "venue_chosen": False,  # True once the venue is settled (chosen, or the only one)
        "options": {},          # what the current step offers: venues / dates / times / max_quantity / suggested_seats
        "date": None,          # "YYYY-MM-DD" in the event time zone
        "time": None,           # "HH:mm"
        "show_at": None,        # ISO instant of the selected show slot (from Node)
        "quantity": None,
        "pending_quantity": None,  # ticket count mentioned before a show was chosen (validated later)
        "seats": [],
        "order": None,          # {session_id, order_id, checkout_url, expires_at, amount_total, currency, status}
        "ticket": None,         # {ticket_id, booking_id} — only after Node confirms PAID
        "notice": None,         # last controlled problem to surface (e.g. payment unavailable)
    }


def empty_search() -> Dict[str, Any]:
    return {
        "filters": {},       # filters of the current search session (reused by "more" / "another")
        "page": 1,           # last page fetched for those filters (relevance order is stable)
        "total": 0,          # total matches reported by Node
        "seen": [],          # ids already shown for the current filters
        "rejected": [],      # ids the user explicitly rejected
        "last_results": [],  # ids of the most recent result list, in display order
        "catalog": {},       # id -> event summary for every event shown in this conversation
        "focus": None,       # id of the event the user explicitly asked about (details)
    }


def empty_refund() -> Dict[str, Any]:
    return {"stage": RefundStage.IDLE.value, "ticket_id": None, "options": [], "quote": None, "action": None}


class AgentState(TypedDict, total=False):
    messages: Annotated[List[AnyMessage], add_messages]

    # Identity (re-hydrated from the verified token every turn; never from the client body)
    user_id: str
    user_name: Optional[str]
    is_authenticated: bool
    city: Optional[str]          # city selected in the app (per turn, from the request)

    # Reply language: "en" or "hi" (Hinglish); persists so short replies keep the conversation's language
    lang: str

    # Persistent domain state
    search: Dict[str, Any]
    booking: Dict[str, Any]
    refund: Dict[str, Any]

    # Per-turn
    intent: Optional[str]
    confidence: Optional[float]
    entities: Dict[str, Any]
    route: Optional[str]
    reply: Dict[str, Any]
