"""
API contract between Angular and the AI service.

The client sends only the message and the conversation it belongs to. Everything else —
identity, booking state, selected event, payment status — is server-side state, returned
in `booking` as the single source of truth the UI renders.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=2000)
    conversation_id: str = Field(..., min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    display_name: Optional[str] = Field(default=None, max_length=80, description="Used only to personalise greetings.")


class EventCard(BaseModel):
    id: str
    title: Optional[str] = None
    category: Optional[str] = None
    venue: Optional[str] = None
    price: Optional[float] = None
    currency: str = "inr"
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    show_times: List[str] = Field(default_factory=list)
    description: Optional[str] = None
    image_url: Optional[str] = None
    available_seats: Optional[int] = None
    rating: Optional[float] = None
    upcoming: Optional[bool] = None


class PaymentView(BaseModel):
    status: Optional[str] = None
    payment_url: Optional[str] = Field(default=None, description="Present only while a real Stripe checkout is open.")
    session_id: Optional[str] = None
    expires_at: Optional[str] = None
    amount_total: Optional[int] = Field(default=None, description="Smallest currency unit, as charged by Stripe.")
    currency: Optional[str] = None


class TicketView(BaseModel):
    ticket_id: str
    booking_id: Optional[str] = None


class BookingView(BaseModel):
    stage: str
    event: Optional[EventCard] = None
    date: Optional[str] = None
    time: Optional[str] = None
    show_at: Optional[str] = None
    quantity: Optional[int] = None
    seats: List[str] = Field(default_factory=list)
    unit_price: Optional[float] = None
    total_price: Optional[float] = None
    options: Dict[str, Any] = Field(default_factory=dict)
    payment: Optional[PaymentView] = None
    ticket: Optional[TicketView] = None


class ChatResponse(BaseModel):
    conversation_id: str
    request_id: str
    response: str
    intent: Optional[str] = None
    agent: Optional[str] = None
    events: List[EventCard] = Field(default_factory=list)
    quick_replies: List[str] = Field(default_factory=list)
    booking: BookingView
    seat_map: Optional[Dict[str, Any]] = None
    faq_sources: List[Dict[str, Any]] = Field(default_factory=list)
    error: Optional[str] = None


class ConversationCreated(BaseModel):
    conversation_id: str
    title: str


class ConversationSummary(BaseModel):
    id: str
    title: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ConversationList(BaseModel):
    conversations: List[ConversationSummary]


class StoredMessage(BaseModel):
    id: int
    role: str
    content: str
    timestamp: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ConversationMessages(BaseModel):
    conversation_id: str
    messages: List[StoredMessage]
    booking: BookingView


class ConversationState(BaseModel):
    conversation_id: str
    booking: BookingView
    notice: Optional[str] = None
