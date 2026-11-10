"""Structured outputs of the two model steps."""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

IntentName = Literal[
    "EVENT_SEARCH", "EVENT_DETAILS", "BOOKING", "BOOKING_STATUS", "REFUND", "REFUND_STATUS",
    "CANCEL_BOOKING", "FAQ_POLICY", "SMALL_TALK", "OUT_OF_DOMAIN", "UNKNOWN",
]

SearchAction = Literal["NEW", "MORE", "REFINE", "CHANGE_TYPE"]


class Rewrite(BaseModel):
    standalone: str = Field(..., max_length=500, description="The latest message as ONE self-contained request in English, with every reference resolved from the conversation.")
    language: Literal["english", "hinglish"] = Field(..., description="Language the user wrote in. Hinglish = Hindi words in Roman script, possibly mixed with English.")
    scope: Literal["events", "small_talk", "out_of_domain"] = Field(..., description="events = anything about events, movies, tickets, bookings, payments, refunds or platform policies.")


class SearchUpdate(BaseModel):
    action: SearchAction = Field(..., description="NEW = a fresh search; MORE = more results of the same search; REFINE = narrow/adjust the current search; CHANGE_TYPE = a different kind/category of event than what was shown.")
    text: Optional[str] = Field(None, description="Title, performer or topic keywords only (e.g. 'dark knight', 'space travel'). Never category, genre, filler or request words.")
    category: Optional[str] = Field(None, description="One of CONTEXT.catalog_categories, copied exactly, when the user asked for that kind of event.")
    genre: Optional[str] = Field(None, description="Genre / style, e.g. comedy, science fiction, horror, rock.")
    venue: Optional[str] = Field(None, description="Venue, theatre or city name.")
    date_from: Optional[str] = Field(None, description="Earliest date YYYY-MM-DD.")
    date_to: Optional[str] = Field(None, description="Latest date YYYY-MM-DD.")
    max_price: Optional[float] = Field(None, description="Maximum ticket price in rupees.")
    exclude_categories: List[str] = Field(default_factory=list, description="Categories the user does NOT want (CHANGE_TYPE, 'not movies').")
    reject_event_ids: List[str] = Field(default_factory=list, description="IDs from KNOWN EVENTS the user rejected ('not this one').")


class StateUpdate(BaseModel):
    intent: IntentName
    confidence: float = Field(..., ge=0.0, le=1.0)
    event_id: Optional[str] = Field(None, description="ID of the event the user refers to. MUST be copied from KNOWN EVENTS; never invent IDs.")
    event_title: Optional[str] = Field(None, description="Event title the user named when it is not in KNOWN EVENTS.")
    search: Optional[SearchUpdate] = None
    venue_choice: Optional[str] = Field(None, description="Venue picked from the offered venue options (copy it exactly).")
    date: Optional[str] = Field(None, description="Show date YYYY-MM-DD picked by the user (resolve 'today', 'tomorrow', weekdays).")
    time: Optional[str] = Field(None, description="Show time picked by the user as 24h HH:mm.")
    quantity: Optional[int] = Field(None, description="Number of tickets requested.")
    seats: List[str] = Field(default_factory=list, description="Seat IDs such as A1, B12.")
    confirmation: Optional[bool] = Field(None, description="True = explicit yes/confirm to the pending question, False = explicit no/decline, null otherwise.")
    cancel_draft: bool = Field(False, description="True when the user wants to abandon the booking currently in progress.")
    ticket_id: Optional[str] = Field(None, description="Ticket ID such as TKT-... if mentioned.")
    payment_check: bool = Field(False, description="True when the user says they paid or asks whether payment went through.")
