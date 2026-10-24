"""
Refund agent: cancellation of completed (paid) bookings, refund requests and refund status.

(Abandoning a booking that is still in progress is handled by the booking agent.)

Flow for CANCEL_BOOKING / REFUND:
    identify booking (ticket ID, or the user's single eligible booking, else ask which)
    → refund quote from Node (policy evaluated by Node)
    → explicit confirmation → Node cancels + refunds via Stripe → report Node's result.
"""

import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from app.agents.common import backend_error_text, login_required_reply, fmt_instant, make_reply, paise_to_rupees
from app.graph.state import Intent, RefundStage, empty_refund
from app.tools import transactions
from services.node_client import NodeAPIError, NodeUnavailable

logger = logging.getLogger(__name__)

AGENT = "refund_agent"
R = RefundStage


def _upcoming_paid(bookings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [b for b in bookings if b.get("payment_status") == "PAID"]


def _option_label(b: Dict[str, Any]) -> str:
    return f"{b.get('ticket_id')} — {b.get('event_title')} ({fmt_instant(b.get('show_at'))})"


def _refund_status_text(b: Dict[str, Any]) -> str:
    status = b.get("payment_status")
    if status == "REFUNDED":
        refund_state = {"succeeded": "completed", "pending": "processing"}.get(str(b.get("refund_status")), b.get("refund_status") or "processing")
        return (
            f"Ticket **{b.get('ticket_id')}** ({b.get('event_title')}) was cancelled and a refund of "
            f"**{paise_to_rupees(b.get('refund_amount'))}** ({b.get('refund_percent')}%) was issued. "
            f"Refund status from the payment provider: **{refund_state}**. "
            "Refunds go back to the original payment method; banks usually take 5–7 business days for cards."
        )
    if status == "REFUND_PROCESSING":
        return f"The refund for ticket **{b.get('ticket_id')}** is being processed."
    if status == "CANCELLED":
        return f"Ticket **{b.get('ticket_id')}** was cancelled with no refund due."
    return f"Ticket **{b.get('ticket_id')}** is **{status}** — no refund has been requested for it."


async def run_refund(
    state: Dict[str, Any], intent: str, entities: Dict[str, Any], *, token: Optional[str]
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    refund = copy.deepcopy(state.get("refund") or empty_refund())
    if not token:
        return login_required_reply(AGENT), empty_refund()
    try:
        if intent == Intent.REFUND_STATUS.value:
            return await _status(refund, entities, token)
        return await _cancel_flow(refund, entities, token)
    except (NodeUnavailable, NodeAPIError) as exc:
        logger.warning("Refund flow failed against Node: %s", exc)
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), refund


async def _status(refund, entities, token):
    ticket_id = entities.get("ticket_id") or refund.get("ticket_id")
    if ticket_id:
        try:
            b = await transactions.refund_status(token, ticket_id)
        except NodeAPIError as exc:
            if exc.status_code in (403, 404):
                return make_reply(f"I couldn't find ticket {ticket_id} on your account.", AGENT), refund
            raise
        return make_reply(_refund_status_text(b), AGENT, quick_replies=["My bookings"]), refund

    bookings = await transactions.list_bookings(token)
    refunded = [b for b in bookings if b.get("payment_status") in ("REFUNDED", "REFUND_PROCESSING", "CANCELLED")]
    if not refunded:
        return make_reply("You don't have any cancelled or refunded bookings.", AGENT, quick_replies=["My bookings"]), refund
    if len(refunded) == 1:
        b = await transactions.refund_status(token, refunded[0]["ticket_id"])
        return make_reply(_refund_status_text(b), AGENT), refund
    lines = "\n".join(f"- {_option_label(b)}" for b in refunded[:6])
    return make_reply(
        f"Which booking's refund would you like to check?\n\n{lines}",
        AGENT,
        quick_replies=[f"Refund status {b['ticket_id']}" for b in refunded[:4]],
    ), refund


async def _cancel_flow(refund, entities, token):
    ticket_id = entities.get("ticket_id")
    stage = R(refund.get("stage") or R.IDLE.value)

    # Answer to "Are you sure?" for the booking we quoted.
    if stage == R.AWAITING_CONFIRMATION and (not ticket_id or ticket_id == refund.get("ticket_id")):
        if entities.get("confirmation") is True:
            return await _execute(refund, token)
        if entities.get("confirmation") is False:
            kept = refund.get("ticket_id")
            return make_reply(f"Okay — ticket **{kept}** is still active. Nothing was cancelled.", AGENT), empty_refund()
        return make_reply(
            f"Please confirm: do you want to cancel ticket **{refund.get('ticket_id')}**? (yes / no)",
            AGENT,
            quick_replies=["Yes, cancel it", "No, keep my ticket"],
        ), refund

    if not ticket_id:
        bookings = _upcoming_paid(await transactions.list_bookings(token))
        if not bookings:
            return make_reply("You don't have any active paid bookings that can be cancelled.", AGENT,
                              quick_replies=["My bookings"]), empty_refund()
        if len(bookings) > 1:
            refund = {**empty_refund(), "stage": R.SELECT_BOOKING.value, "options": [b["ticket_id"] for b in bookings]}
            lines = "\n".join(f"- {_option_label(b)}" for b in bookings[:8])
            return make_reply(
                f"You have {len(bookings)} active bookings. Which one would you like to cancel?\n\n{lines}",
                AGENT,
                quick_replies=[f"Cancel {b['ticket_id']}" for b in bookings[:4]],
            ), refund
        ticket_id = bookings[0]["ticket_id"]

    try:
        data = await transactions.refund_quote(token, ticket_id)
    except NodeAPIError as exc:
        if exc.status_code in (403, 404):
            return make_reply(f"I couldn't find ticket {ticket_id} on your account.", AGENT), empty_refund()
        raise
    b, quote = data["booking"], data["quote"]

    if not quote.get("eligible"):
        return make_reply(
            f"Ticket **{ticket_id}** ({b.get('event_title')}, {fmt_instant(b.get('show_at'))}) can't be cancelled: {quote.get('reason')}",
            AGENT,
            quick_replies=["Cancellation policy", "My bookings"],
        ), empty_refund()

    refund = {**empty_refund(), "stage": R.AWAITING_CONFIRMATION.value, "ticket_id": ticket_id, "quote": quote}
    seats = ", ".join(b.get("seat_numbers") or []) or f"{b.get('seats')} seat(s)"
    text = (
        f"Here's what cancelling ticket **{ticket_id}** means:\n\n"
        f"- 🎬 **Event:** {b.get('event_title')}\n"
        f"- 📅 **Show:** {fmt_instant(b.get('show_at'))}\n"
        f"- 💺 **Seats:** {seats}\n"
        f"- 💳 **Paid:** {paise_to_rupees(b.get('amount_paid'))}\n"
        f"- 💰 **Refund under the cancellation policy:** {quote.get('refundPercent')}% = **{paise_to_rupees(quote.get('refundAmount'))}**\n\n"
        "Do you want to cancel this booking? This can't be undone."
    )
    return make_reply(text, AGENT, quick_replies=["Yes, cancel it", "No, keep my ticket"]), refund


async def _execute(refund, token):
    ticket_id = refund["ticket_id"]
    try:
        result = await transactions.request_refund(token, ticket_id)
    except NodeAPIError as exc:
        logger.info("Refund rejected by Node for %s: %s", ticket_id, exc)
        return make_reply(f"The cancellation could not be completed: {exc.message}", AGENT, error=exc.code or "REFUND_FAILED"), empty_refund()

    b = result["booking"]
    if result.get("status") == "REFUNDED":
        text = (
            f"✅ Ticket **{ticket_id}** has been cancelled. A refund of **{paise_to_rupees(b.get('refund_amount'))}** "
            f"was issued to your original payment method (refund status: **{b.get('refund_status')}**)."
        )
    elif result.get("status") == "CANCELLED":
        text = f"✅ Ticket **{ticket_id}** has been cancelled. No refund amount was due for this booking."
    else:
        text = f"The booking system reported status **{result.get('status')}** for ticket {ticket_id}."
    return make_reply(text, AGENT, quick_replies=[f"Refund status {ticket_id}", "My bookings"]), empty_refund()
