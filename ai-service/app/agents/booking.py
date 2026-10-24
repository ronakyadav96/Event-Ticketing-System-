"""
Booking agent: the step-by-step booking state machine and booking status lookups.

    SELECT_VENUE → SELECT_DATE → SELECT_SHOWTIME → SELECT_QUANTITY → SELECT_SEATS
        → REVIEW (explicit confirmation) → PAYMENT_PENDING (Stripe checkout, seats LOCKED)
        → COMPLETED (Node verified payment and created the booking)

Every option offered (venues, dates, showtimes, seats, price) comes from Node. Steps whose
answer is fully determined by the data (a single venue / date / showtime) are filled in and
announced, never guessed. Changing an earlier choice clears every later one. Only Node's
order status can move the booking to COMPLETED; nothing the user says can.
"""

import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from app.agents.common import (
    LOGIN_REQUIRED,
    LOGIN_TO_BOOK,
    login_required_reply,
    backend_error_text,
    fmt_date,
    fmt_instant,
    fmt_time,
    make_reply,
    paise_to_rupees,
    rupees,
)
from app.agents.resolve import remember_events, resolve_event_reference
from app.graph.state import BookingStage, empty_booking, empty_search
from app.tools import catalog as catalog_tools
from app.tools import transactions
from config import settings
from services.node_client import NodeAPIError, NodeUnavailable

logger = logging.getLogger(__name__)

AGENT = "booking_agent"
S = BookingStage
_DOWNSTREAM = ["date", "time", "show_at", "quantity", "seats"]


class _Halt(Exception):
    """Stop processing this turn and answer with `reply`."""

    def __init__(self, reply: Dict[str, Any]):
        self.reply = reply


def _clear_from(booking: Dict[str, Any], field: str) -> None:
    for key in _DOWNSTREAM[_DOWNSTREAM.index(field):]:
        booking[key] = [] if key == "seats" else None


def is_trusted_payment_url(url: Optional[str]) -> bool:
    return bool(url) and any(str(url).startswith(p) for p in settings.payment_url_prefixes)


# ── Payment status (authoritative: Node order) ────────────────────────────────

def _apply_order(booking: Dict[str, Any], order: Dict[str, Any]) -> Optional[str]:
    """Update booking from Node's order view. Returns a status note for the user, if any."""
    status = order.get("status")
    if status == "PAID" and order.get("ticketId"):
        booking["stage"] = S.COMPLETED.value
        booking["ticket"] = {"ticket_id": order["ticketId"], "booking_id": order.get("bookingId")}
        booking["order"] = {**(booking.get("order") or {}), "status": "PAID", "checkout_url": None}
        booking["notice"] = None
        return None
    if status == "PENDING":
        current = booking.get("order") or {}
        url = order.get("checkoutUrl") if is_trusted_payment_url(order.get("checkoutUrl")) else None
        booking["order"] = {**current, "status": "PENDING", "checkout_url": url, "expires_at": order.get("expiresAt")}
        return None
    # EXPIRED / CANCELLED / FAILED: seats were released by Node; go back to the summary.
    booking["stage"] = S.REVIEW.value
    booking["order"] = None
    reason = order.get("failureReason")
    if status == "EXPIRED":
        return "The payment window expired before payment was completed, so your seats were released. No charge was made."
    if status == "CANCELLED":
        return "That payment was cancelled and your seats were released. No charge was made."
    return f"The payment could not be completed{f': {reason}' if reason else ''}. Your seats were released."


async def refresh_payment(booking: Dict[str, Any], token: Optional[str]) -> Optional[str]:
    """Sync a PAYMENT_PENDING booking with Node. Mutates `booking`; returns a note or None."""
    order = booking.get("order") or {}
    if booking.get("stage") != S.PAYMENT_PENDING.value or not order.get("session_id") or not token:
        return None
    try:
        result = await transactions.get_order(token, order["session_id"])
    except NodeAPIError as exc:
        if exc.status_code not in (403, 404):
            raise
        # The payment session is unknown to Node: never assume it was paid.
        booking["stage"] = S.REVIEW.value
        booking["order"] = None
        return "I couldn't find that payment session any more. Nothing was charged through it — you can start the payment again."
    return _apply_order(booking, result)


# ── Prompts for each step ─────────────────────────────────────────────────────

def _summary_lines(booking: Dict[str, Any]) -> List[str]:
    ev = booking.get("event") or {}
    lines = [f"🎬 **Event:** {ev.get('title')}", f"📍 **Venue:** {ev.get('venue')}"]
    if booking.get("date"):
        lines.append(f"📅 **Date:** {fmt_date(booking['date'])}")
    if booking.get("time"):
        lines.append(f"🕒 **Showtime:** {fmt_time(booking['time'])}")
    if booking.get("quantity"):
        lines.append(f"🎟️ **Tickets:** {booking['quantity']}")
    if booking.get("seats"):
        lines.append(f"💺 **Seats:** {', '.join(booking['seats'])}")
    return lines


def _suggest_seats(availability: Dict[str, Any], quantity: int) -> List[List[str]]:
    """Up to three contiguous same-row blocks: front rows first, centre of each row first."""
    available = set(availability.get("available") or [])
    rows = availability.get("rows") or []
    blocks: List[List[str]] = []
    for i in range(len(rows)):
        seats = rows[i]["seats"]
        mid = len(seats) // 2
        starts = sorted(range(0, len(seats) - quantity + 1), key=lambda s: abs(s + quantity / 2 - mid))
        for start in starts:
            block = seats[start:start + quantity]
            if all(s in available for s in block):
                blocks.append(block)
                break
        if len(blocks) == 3:
            break
    return blocks


def _seat_map(availability: Dict[str, Any], selected: List[str]) -> Dict[str, Any]:
    return {
        "rows": availability.get("rows") or [],
        "unavailable": sorted(set((availability.get("booked") or []) + (availability.get("locked") or []))),
        "selected": selected,
        "show_at": availability.get("showAt"),
    }


def _prompt(booking: Dict[str, Any], notes: List[str], availability: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    stage = S(booking["stage"])
    ev = booking.get("event") or {}
    options = booking.get("options") or {}
    head = "\n\n".join(n for n in notes if n)
    head = f"{head}\n\n" if head else ""
    quick: List[str] = []
    seat_map = None

    if stage == S.SELECT_VENUE:
        venues = options.get("venues") or []
        # The options themselves are rendered by the UI's option picker (booking.options).
        body = f"**{ev.get('title')}** is playing at {len(venues)} venues. Which one would you like?"
        quick = venues[:5]
    elif stage == S.SELECT_DATE:
        dates = options.get("dates") or []
        body = f"Which date would you like for **{ev.get('title')}** at {ev.get('venue')}?"
        quick = [fmt_date(d) for d in dates[:5]]
    elif stage == S.SELECT_SHOWTIME:
        times = options.get("times") or []
        body = f"Which showtime on **{fmt_date(booking.get('date'))}**?"
        quick = [fmt_time(t) for t in times[:6]]
    elif stage == S.SELECT_QUANTITY:
        mx = options.get("max_quantity") or 0
        body = f"How many tickets would you like? Tickets are {rupees(ev.get('price'))} each (up to {mx} per booking)."
        quick = [f"{n} ticket{'s' if n > 1 else ''}" for n in range(1, min(mx, 4) + 1)]
    elif stage == S.SELECT_SEATS:
        qty = booking.get("quantity") or 0
        picked = booking.get("seats") or []
        count = (availability or {}).get("availableCount")
        need = qty - len(picked)
        body = f"Please select **{need}** seat{'s' if need != 1 else ''}"
        body += f" ({count} available for this show)." if count is not None else "."
        if picked:
            body += f" Selected so far: {', '.join(picked)}."
        suggestions = options.get("suggested_seats") or []
        if suggestions:
            body += " Pick them on the seat map, or tap a suggested block below."
            quick = [", ".join(b) for b in suggestions]
        if availability:
            seat_map = _seat_map(availability, picked)
    elif stage == S.REVIEW:
        qty = booking.get("quantity") or 0
        lines = _summary_lines(booking)
        lines.append(f"💰 **Total:** {rupees(ev.get('price'))} × {qty} = **{rupees((ev.get('price') or 0) * qty)}**")
        body = "Here is your booking summary:\n\n" + "\n".join(f"- {l}" for l in lines)
        body += "\n\nWould you like to confirm and proceed to payment?"
        quick = ["Yes, proceed to payment", "Change seats", "Cancel booking"]
    elif stage == S.PAYMENT_PENDING:
        order = booking.get("order") or {}
        body = (
            "💳 Your seats are reserved. Please complete the payment on the secure Stripe page to confirm your tickets.\n\n"
            + "\n".join(f"- {l}" for l in _summary_lines(booking))
            + f"\n- 💰 **Amount:** {paise_to_rupees(order.get('amount_total'))}"
        )
        if order.get("expires_at"):
            body += f"\n\n⏳ Seats are held until {fmt_instant(order['expires_at'])}. Your ticket is issued only after Stripe confirms the payment."
        quick = ["I've completed the payment", "Cancel booking"]
    elif stage == S.COMPLETED:
        ticket = booking.get("ticket") or {}
        body = (
            "✅ **Payment verified — your booking is confirmed!**\n\n"
            + f"- 🎫 **Ticket ID:** {ticket.get('ticket_id')}\n"
            + "\n".join(f"- {l}" for l in _summary_lines(booking))
            + f"\n- 💰 **Paid:** {paise_to_rupees((booking.get('order') or {}).get('amount_total'))}"
        )
        quick = ["My bookings", "Show me more events"]
    else:
        body = "What would you like to book?"
        quick = ["Show me movies", "Upcoming events"]

    return make_reply(head + body, AGENT, quick_replies=quick, seat_map=seat_map)


# ── Main entry ────────────────────────────────────────────────────────────────

async def run_booking(
    state: Dict[str, Any],
    entities: Dict[str, Any],
    *,
    token: Optional[str],
    is_authenticated: bool,
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    booking = copy.deepcopy(state.get("booking") or empty_booking())
    search = copy.deepcopy(state.get("search") or empty_search())
    try:
        reply = await _advance(booking, search, entities, token=token, is_authenticated=is_authenticated)
    except _Halt as halt:
        reply = halt.reply
    except (NodeUnavailable, NodeAPIError) as exc:
        logger.warning("Booking step failed against Node: %s", exc)
        reply = make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE")
    return reply, booking, search


async def _advance(booking, search, entities, *, token, is_authenticated) -> Dict[str, Any]:
    notes: List[str] = []
    stage = S(booking.get("stage") or S.IDLE.value)

    # 1. A checkout is open: Stripe/Node decide what happens next, not the conversation.
    if stage == S.PAYMENT_PENDING:
        if not token:
            raise _Halt(login_required_reply(AGENT))
        if entities.get("cancel_draft"):
            order = booking.get("order") or {}
            result = await transactions.cancel_order(token, order["session_id"])
            if result.get("status") == "PAID":
                _apply_order(booking, result)
                return _prompt(booking, ["Your payment had already gone through, so the booking could not be cancelled."], None)
            booking.clear()
            booking.update(empty_booking())
            return make_reply(
                "Your booking has been cancelled and the seats were released. No payment was taken.",
                AGENT,
                quick_replies=["Show me movies", "Upcoming events"],
            )
        note = await refresh_payment(booking, token)
        stage = S(booking["stage"])
        if stage == S.PAYMENT_PENDING:
            if entities.get("payment_check"):
                notes.append("I haven't received a payment confirmation from Stripe yet.")
            elif _wants_change(entities):
                notes.append("Your seats are currently held for payment. Please complete the payment, or cancel this booking to make changes.")
            return _prompt(booking, notes, None)
        if stage == S.COMPLETED:
            return _prompt(booking, [], None)
        notes.append(note or "")

    # 2. Abandon a draft booking.
    if entities.get("cancel_draft"):
        had_draft = stage not in (S.IDLE, S.COMPLETED)
        booking.clear()
        booking.update(empty_booking())
        text = "Okay, I've cancelled this booking. No payment was taken." if had_draft else "There's no booking in progress to cancel."
        return make_reply(text, AGENT, quick_replies=["Show me movies", "Upcoming events"])

    # 3. A finished booking is history; a new booking request starts fresh.
    if stage == S.COMPLETED:
        if entities.get("payment_check"):
            return _prompt(booking, [], None)
        booking.clear()
        booking.update(empty_booking())
        stage = S.IDLE

    # 4. Guests sign in before choosing seats: signing in later switches identity and would
    #    discard every step they had already completed.
    if not is_authenticated and stage == S.IDLE:
        raise _Halt(login_required_reply(AGENT, LOGIN_TO_BOOK))

    # 5. Which event?
    await _select_event(booking, search, entities, notes)

    # 6. Venue → date → showtime → quantity → seats, each validated against Node data.
    await _select_venue(booking, entities, notes)
    if entities.get("quantity") and not booking.get("show_at"):
        booking["pending_quantity"] = entities["quantity"]  # applied once a show is chosen
    if not booking.get("venue_chosen"):
        booking["stage"] = S.SELECT_VENUE.value
        return _prompt(booking, notes, None)
    schedule = await catalog_tools.get_schedule(booking["event"]["id"])
    _select_date(booking, schedule, entities, notes)
    _select_time(booking, schedule, entities, notes)

    availability = None
    if booking.get("show_at"):
        availability = await catalog_tools.get_availability(booking["event"]["id"], booking["show_at"])
        _select_quantity(booking, availability, schedule, entities, notes)
        _select_seats(booking, availability, entities, notes)

    _set_next_stage(booking)

    # 7. Explicit confirmation → Stripe checkout (via Node).
    if S(booking["stage"]) == S.REVIEW and entities.get("confirmation") is True:
        return await _start_checkout(booking, availability, token=token, is_authenticated=is_authenticated)
    if S(booking["stage"]) == S.REVIEW and entities.get("confirmation") is False:
        notes.append("No problem — nothing has been booked. You can change the date, showtime, tickets or seats, or cancel.")

    return _prompt(booking, notes, availability)


def _wants_change(entities: Dict[str, Any]) -> bool:
    return any(entities.get(k) for k in ("venue_choice", "date", "time", "quantity", "seats", "event_id", "event_title"))


async def _select_event(booking, search, entities, notes) -> None:
    current = booking.get("event")
    named = entities.get("event_id") or entities.get("event_title")

    if current and not named:
        return

    last = search.get("last_results") or []
    fallback = None if named else (search.get("focus") or (last[0] if len(last) == 1 else None))
    outcome, value = await resolve_event_reference(search, entities, fallback_id=fallback)

    if outcome == "ambiguous":
        remember_events(search, value, as_last_results=True)
        lines = "\n".join(f"{i}. **{e['title']}** — {e.get('venue')}" for i, e in enumerate(value, 1))
        raise _Halt(make_reply(f"Which of these would you like to book?\n\n{lines}", AGENT, events=value,
                               quick_replies=[f"Book {e['title']}" for e in value[:4]]))
    if outcome == "none":
        if current:
            notes.append(f"I couldn't find “{entities.get('event_title')}”, so I've kept **{current['title']}**.")
            return
        if last:
            options = [search["catalog"][i] for i in last if i in search.get("catalog", {})]
            raise _Halt(make_reply("Which event would you like to book?", AGENT,
                                   quick_replies=[f"Book {e['title']}" for e in options[:4]]))
        text = (f"I couldn't find an event called “{entities['event_title']}”."
                if entities.get("event_title") else "Which event would you like to book? You can ask me to search first.")
        raise _Halt(make_reply(text, AGENT, quick_replies=["Show me movies", "Upcoming events"]))

    if current and current["id"] == value["id"]:
        return
    event = await catalog_tools.get_event(value["id"])
    remember_events(search, [event], as_last_results=False)
    if current:
        notes.append(f"Switched your booking to **{event['title']}** — previous selections were cleared.")
    if not current or current.get("title") != event.get("title"):
        booking["venue_options"] = []
        booking["venue_chosen"] = False
    booking["event"] = event
    booking["options"] = {}
    _clear_from(booking, "date")


async def _select_venue(booking, entities, notes) -> None:
    event = booking["event"]
    if not booking.get("venue_options"):
        same_title = (await catalog_tools.search_events(title=event["title"], limit=20))["events"]
        venues = {}
        for ev in same_title:
            # Only venues whose run is still on can be booked.
            if ev.get("venue") and ev.get("upcoming") is not False:
                venues.setdefault(ev["venue"], ev["id"])
        venues.setdefault(event.get("venue"), event["id"])
        booking["venue_options"] = [{"venue": v, "event_id": i} for v, i in venues.items()]

    options = booking["venue_options"]
    wanted = entities.get("venue_choice") or ((entities.get("search") or {}).get("venue"))
    if wanted:
        match = [o for o in options if o["venue"].lower() == wanted.lower()] or [
            o for o in options if wanted.lower() in o["venue"].lower()
        ]
        if len(match) == 1:
            if match[0]["event_id"] != event["id"]:
                booking["event"] = await catalog_tools.get_event(match[0]["event_id"])
                _clear_from(booking, "date")
            booking["venue_chosen"] = True
        else:
            notes.append(f"“{wanted}” isn't one of the venues for this show.")

    if len(options) == 1:
        booking["venue_chosen"] = True
    booking.setdefault("options", {})["venues"] = [o["venue"] for o in options] if len(options) > 1 else []


def _select_date(booking, schedule, entities, notes) -> None:
    dates = schedule.get("dates") or []
    booking.setdefault("options", {})["dates"] = dates
    if not dates:
        title = booking["event"]["title"]
        booking.clear()
        booking.update(empty_booking())
        raise _Halt(make_reply(f"Sorry, **{title}** has no upcoming shows available to book right now.", AGENT,
                               quick_replies=["Show me something else"]))

    wanted = entities.get("date")
    if wanted:
        if wanted in dates:
            if wanted != booking.get("date"):
                _clear_from(booking, "date")
                booking["date"] = wanted
        elif wanted > dates[-1]:
            notes.append(f"I can currently book shows up to {fmt_date(dates[-1])}.")
        else:
            notes.append(f"There are no shows on {fmt_date(wanted)}.")
    if booking.get("date") and booking["date"] not in dates:
        notes.append(f"Shows on {fmt_date(booking['date'])} are no longer available.")
        _clear_from(booking, "date")
    if not booking.get("date") and len(dates) == 1:
        booking["date"] = dates[0]
        notes.append(f"This show runs only on {fmt_date(dates[0])}.")


def _select_time(booking, schedule, entities, notes) -> None:
    if not booking.get("date"):
        return
    slots = [s for s in schedule.get("slots") or [] if s["date"] == booking["date"]]
    times = [s["time"] for s in slots]
    booking["options"]["times"] = times

    wanted = entities.get("time")
    if wanted:
        if wanted in times:
            if wanted != booking.get("time"):
                _clear_from(booking, "time")
                booking["time"] = wanted
        else:
            notes.append(f"{fmt_time(wanted)} isn't available on {fmt_date(booking['date'])}.")
    if booking.get("time") and booking["time"] not in times:
        _clear_from(booking, "time")
    if not booking.get("time") and len(times) == 1:
        booking["time"] = times[0]
        notes.append(f"The only showtime that day is {fmt_time(times[0])}.")
    slot = next((s for s in slots if s["time"] == booking.get("time")), None)
    booking["show_at"] = slot["showAt"] if slot else None


def _select_quantity(booking, availability, schedule, entities, notes) -> None:
    available = int(availability.get("availableCount") or 0)
    max_q = min(int(availability.get("maxSeatsPerBooking") or schedule.get("maxSeatsPerBooking") or 10), available)
    booking["options"]["max_quantity"] = max_q
    if available == 0:
        notes.append("This show is sold out — please pick another showtime or date.")
        _clear_from(booking, "time")
        return

    pending = booking.pop("pending_quantity", None)
    wanted = entities.get("quantity") or (pending if not booking.get("quantity") else None)
    if not wanted and entities.get("seats") and not booking.get("quantity"):
        wanted = len(entities["seats"])
    if wanted:
        if 1 <= wanted <= max_q:
            if wanted != booking.get("quantity"):
                booking["quantity"] = wanted
                if len(booking.get("seats") or []) != wanted:
                    booking["seats"] = []
        else:
            notes.append(f"You can book between 1 and {max_q} tickets for this show.")


def _select_seats(booking, availability, entities, notes) -> None:
    qty = booking.get("quantity")
    available = set(availability.get("available") or [])
    all_seats = {s for r in availability.get("rows") or [] for s in r["seats"]}

    # Seats chosen earlier may have been taken since; re-validate every turn.
    lost = [s for s in booking.get("seats") or [] if s not in available]
    if lost:
        notes.append(f"Seat(s) {', '.join(lost)} are no longer available.")
        booking["seats"] = [s for s in booking["seats"] if s not in lost]

    if qty:
        booking["options"]["suggested_seats"] = _suggest_seats(availability, qty - len(booking.get("seats") or []) or qty)

    requested = entities.get("seats") or []
    if not requested or not qty:
        return
    unknown = [s for s in requested if s not in all_seats]
    taken = [s for s in requested if s in all_seats and s not in available]
    if unknown:
        notes.append(f"Seat(s) {', '.join(unknown)} don't exist for this venue.")
    if taken:
        notes.append(f"Seat(s) {', '.join(taken)} are already taken.")
    valid = [s for s in requested if s in available]
    if unknown or taken:
        return

    current = booking.get("seats") or []
    merged = valid if len(valid) >= qty or not current else list(dict.fromkeys(current + valid))
    if len(merged) > qty:
        notes.append(f"You selected {len(merged)} seats but booked {qty} ticket{'s' if qty > 1 else ''}. Please choose exactly {qty}.")
        return
    booking["seats"] = merged
    if len(merged) < qty:
        booking["options"]["suggested_seats"] = _suggest_seats(availability, qty - len(merged))


def _set_next_stage(booking) -> None:
    if not booking.get("event"):
        booking["stage"] = S.IDLE.value
    elif not booking.get("venue_chosen") and len(booking.get("venue_options") or []) > 1:
        booking["stage"] = S.SELECT_VENUE.value
    elif not booking.get("date"):
        booking["stage"] = S.SELECT_DATE.value
    elif not booking.get("time"):
        booking["stage"] = S.SELECT_SHOWTIME.value
    elif not booking.get("quantity"):
        booking["stage"] = S.SELECT_QUANTITY.value
    elif len(booking.get("seats") or []) != booking["quantity"]:
        booking["stage"] = S.SELECT_SEATS.value
    else:
        booking["stage"] = S.REVIEW.value


async def _start_checkout(booking, availability, *, token, is_authenticated) -> Dict[str, Any]:
    if not is_authenticated or not token:
        reply = _prompt(booking, [LOGIN_REQUIRED], availability)
        reply["error"] = "LOGIN_REQUIRED"
        return reply
    try:
        order = await transactions.create_checkout(
            token, event_id=booking["event"]["id"], show_at=booking["show_at"], seats=booking["seats"]
        )
    except NodeAPIError as exc:
        if exc.code == "SEATS_UNAVAILABLE":
            taken = exc.payload.get("unavailable") or []
            booking["seats"] = [s for s in booking["seats"] if s not in taken]
            booking["stage"] = S.SELECT_SEATS.value
            fresh = await catalog_tools.get_availability(booking["event"]["id"], booking["show_at"])
            booking["options"]["suggested_seats"] = _suggest_seats(fresh, booking["quantity"] - len(booking["seats"]))
            return _prompt(booking, [f"Sorry — seat(s) {', '.join(taken)} were just taken by someone else."], fresh)
        if exc.code == "INVALID_SHOWTIME":
            _clear_from(booking, "time")
            _set_next_stage(booking)
            return _prompt(booking, ["That show is no longer available for booking."], None)
        if exc.code == "PAYMENT_UNAVAILABLE":
            booking["notice"] = "PAYMENT_UNAVAILABLE"
            return make_reply(
                "⚠️ The payment service is unavailable right now, so I couldn't start the payment. "
                "Nothing was booked or charged. Please try again in a few minutes.",
                AGENT,
                quick_replies=["Try payment again", "Cancel booking"],
                error="PAYMENT_UNAVAILABLE",
            )
        if exc.status_code == 401:
            return _prompt(booking, ["Your session has expired. Please log in again to continue."], availability)
        return _prompt(booking, [f"I couldn't start the payment: {exc.message}"], availability)

    url = order.get("checkoutUrl")
    if not is_trusted_payment_url(url) or not order.get("sessionId"):
        logger.error("Checkout response without a trusted Stripe URL: %s", {k: order.get(k) for k in ("status", "sessionId")})
        return make_reply(
            "⚠️ I couldn't start a secure payment session. Nothing was booked or charged. Please try again shortly.",
            AGENT,
            error="PAYMENT_UNAVAILABLE",
        )

    booking["stage"] = S.PAYMENT_PENDING.value
    booking["notice"] = None
    booking["order"] = {
        "session_id": order["sessionId"],
        "order_id": order.get("orderId"),
        "checkout_url": url,
        "expires_at": order.get("expiresAt"),
        "amount_total": order.get("amountTotal"),
        "currency": order.get("currency"),
        "status": order.get("status"),
    }
    return _prompt(booking, [], None)


# ── Booking status ─────────────────────────────────────────────────────────────

def _booking_line(b: Dict[str, Any]) -> str:
    seats = ", ".join(b["seat_numbers"]) if b.get("seat_numbers") else f"{b.get('seats')} seat(s)"
    return f"**{b.get('ticket_id')}** — {b.get('event_title')} · {fmt_instant(b.get('show_at'))} · {seats} · {b.get('payment_status')}"


async def run_booking_status(state: Dict[str, Any], entities: Dict[str, Any], *, token: Optional[str]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    booking = copy.deepcopy(state.get("booking") or empty_booking())
    if not token:
        return login_required_reply(AGENT), booking
    notes: List[str] = []
    try:
        if booking.get("stage") == S.PAYMENT_PENDING.value:
            note = await refresh_payment(booking, token)
            if booking["stage"] == S.COMPLETED.value:
                notes.append(f"Good news — your payment was verified and ticket **{booking['ticket']['ticket_id']}** is confirmed.")
            elif booking["stage"] == S.PAYMENT_PENDING.value:
                notes.append("You also have a booking waiting for payment in this chat.")
            elif note:
                notes.append(note)

        ticket_id = entities.get("ticket_id")
        if ticket_id:
            try:
                b = await transactions.get_booking(token, ticket_id)
            except NodeAPIError as exc:
                if exc.status_code in (403, 404):
                    return make_reply(f"I couldn't find a booking with ticket ID {ticket_id} on your account.", AGENT), booking
                raise
            text = "\n\n".join(notes + [f"Here's your booking:\n\n- {_booking_line(b)}"])
            return make_reply(text, AGENT, quick_replies=["My bookings", "Cancellation policy"]), booking

        bookings = await transactions.list_bookings(token)
    except (NodeUnavailable, NodeAPIError) as exc:
        return make_reply(backend_error_text(exc), AGENT, error="BACKEND_UNAVAILABLE"), booking

    if not bookings:
        notes.append("You don't have any bookings yet.")
        return make_reply("\n\n".join(notes), AGENT, quick_replies=["Show me movies", "Upcoming events"]), booking
    bookings.sort(key=lambda b: str(b.get("show_at") or ""), reverse=True)
    shown = bookings[:5]
    text = f"You have {len(bookings)} booking{'s' if len(bookings) != 1 else ''}" + (" (latest 5):" if len(bookings) > 5 else ":")
    text += "\n\n" + "\n".join(f"- {_booking_line(b)}" for b in shown)
    notes.append(text)
    return make_reply("\n\n".join(notes), AGENT, quick_replies=[f"Status of {b['ticket_id']}" for b in shown[:3]]), booking
