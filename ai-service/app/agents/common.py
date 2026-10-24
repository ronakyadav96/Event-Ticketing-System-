"""Shared helpers for agent replies and formatting of authoritative data."""

from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from config import settings
from services.node_client import NodeAPIError, NodeUnavailable

BACKEND_UNAVAILABLE = (
    "I can't reach the booking system right now, so I can't give you reliable information. "
    "Please try again in a moment."
)
LOGIN_REQUIRED = "Please log in to your account first — I can only access bookings, payments and refunds for signed-in users."
LOGIN_TO_BOOK = "🔒 Please log in to book tickets — it only takes a moment, and I'll bring you straight back to this booking."


def login_required_reply(agent: str, text: str = LOGIN_REQUIRED) -> Dict[str, Any]:
    """The UI shows a sign-in button for replies carrying the LOGIN_REQUIRED code."""
    return make_reply(text, agent, error="LOGIN_REQUIRED")


def make_reply(
    text: str,
    agent: str,
    *,
    events: Optional[List[Dict[str, Any]]] = None,
    quick_replies: Optional[List[str]] = None,
    faq_sources: Optional[List[Dict[str, Any]]] = None,
    seat_map: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "text": text,
        "agent": agent,
        "events": events or [],
        "quick_replies": [q for q in (quick_replies or []) if q][:6],
        "faq_sources": faq_sources or [],
        "seat_map": seat_map,
        "error": error,
    }


def backend_error_text(exc: Exception) -> str:
    if isinstance(exc, NodeAPIError):
        return exc.message
    if isinstance(exc, NodeUnavailable):
        return BACKEND_UNAVAILABLE
    return BACKEND_UNAVAILABLE


def rupees(amount: Any) -> str:
    """Format a rupee amount (event prices are stored in rupees)."""
    try:
        value = float(amount)
    except (TypeError, ValueError):
        return "—"
    return f"₹{value:,.0f}" if value == int(value) else f"₹{value:,.2f}"


def paise_to_rupees(amount: Any) -> str:
    try:
        return rupees(float(amount) / 100)
    except (TypeError, ValueError):
        return "—"


def fmt_date(date_str: Optional[str]) -> str:
    if not date_str:
        return "—"
    try:
        return datetime.strptime(date_str, "%Y-%m-%d").strftime("%a, %d %b %Y")
    except ValueError:
        return date_str


def fmt_time(hhmm: Optional[str]) -> str:
    if not hhmm:
        return "—"
    try:
        return datetime.strptime(hhmm, "%H:%M").strftime("%I:%M %p").lstrip("0")
    except ValueError:
        return hhmm


def fmt_instant(iso: Optional[str]) -> str:
    if not iso:
        return "—"
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(ZoneInfo(settings.EVENT_TIMEZONE))
    except ValueError:
        return str(iso)
    return dt.strftime("%a, %d %b %Y · %I:%M %p").replace(" 0", " ")


def first_name(user_name: Optional[str]) -> str:
    name = (user_name or "").strip()
    return name.split()[0] if name else ""
