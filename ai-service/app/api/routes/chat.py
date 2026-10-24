"""
Chat and conversation endpoints.

Every conversation belongs to exactly one identity (authenticated user id or guest id).
Each request re-checks ownership before touching messages or LangGraph state, and state is
always loaded from the user-scoped thread "<user_id>::<conversation_id>".
"""

import logging
import time
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.agents.booking import is_trusted_payment_url, refresh_payment
from app.api.dependencies import Identity, get_identity
from app.api.schemas import (
    BookingView,
    ChatRequest,
    ChatResponse,
    ConversationCreated,
    ConversationList,
    ConversationMessages,
    ConversationState,
    ConversationSummary,
    EventCard,
    PaymentView,
    StoredMessage,
    TicketView,
)
from app.graph.workflow import delete_thread, get_thread_state, run_turn, update_thread_state
from app.graph.state import BookingStage, empty_booking
from db import ConversationBusy, get_store, turn_lock
from services.node_client import NodeAPIError, NodeUnavailable

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Helpers ──────────────────────────────────────────────────────────────────

def booking_view(booking: Optional[Dict[str, Any]]) -> BookingView:
    b = booking or empty_booking()
    stage = b.get("stage") or BookingStage.IDLE.value
    event = b.get("event")
    price = (event or {}).get("price")
    qty = b.get("quantity")
    options = {k: v for k, v in (b.get("options") or {}).items() if k in ("venues", "dates", "times", "max_quantity", "suggested_seats") and v}

    payment = None
    order = b.get("order") or {}
    if stage == BookingStage.PAYMENT_PENDING.value and order:
        url = order.get("checkout_url")
        payment = PaymentView(
            status="PENDING",
            payment_url=url if is_trusted_payment_url(url) else None,
            session_id=order.get("session_id"),
            expires_at=order.get("expires_at"),
            amount_total=order.get("amount_total"),
            currency=order.get("currency"),
        )
    elif stage == BookingStage.COMPLETED.value and order:
        payment = PaymentView(status="PAID", amount_total=order.get("amount_total"), currency=order.get("currency"))

    ticket = None
    if stage == BookingStage.COMPLETED.value and (b.get("ticket") or {}).get("ticket_id"):
        ticket = TicketView(**b["ticket"])

    return BookingView(
        stage=stage,
        event=EventCard(**event) if event else None,
        date=b.get("date"),
        time=b.get("time"),
        show_at=b.get("show_at"),
        quantity=qty,
        seats=b.get("seats") or [],
        unit_price=price,
        total_price=(price * qty) if (price is not None and qty) else None,
        options=options,
        payment=payment,
        ticket=ticket,
    )


async def _require_owner(conversation_id: str, identity: Identity) -> None:
    owner = await get_store().get_owner(conversation_id)
    # Same answer for "missing" and "someone else's" so IDs cannot be probed.
    if owner != identity.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")


# ── Chat turn ────────────────────────────────────────────────────────────────

@router.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest, request: Request, identity: Identity = Depends(get_identity)) -> ChatResponse:
    started = time.perf_counter()
    request_id = request.headers.get("X-Request-ID") or f"req_{uuid.uuid4().hex[:12]}"
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Message is empty.")

    store = get_store()
    owner = await store.get_owner(body.conversation_id)
    if owner is None:
        await store.create(body.conversation_id, identity.user_id, "New Chat")
    elif owner != identity.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found.")

    try:
        async with turn_lock.hold(f"{identity.user_id}::{body.conversation_id}"):
            await store.add_message(body.conversation_id, "user", message, {})
            try:
                final = await run_turn(
                    query=message,
                    conversation_id=body.conversation_id,
                    user_id=identity.user_id,
                    user_name=body.display_name if identity.is_authenticated else None,
                    is_authenticated=identity.is_authenticated,
                    auth_token=identity.token,
                )
            except Exception:
                logger.exception("[%s] Agent turn failed", request_id)
                await store.add_message(body.conversation_id, "assistant", "Sorry, something went wrong while processing that. Please try again.", {"error": "INTERNAL_ERROR"})
                raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="The assistant could not process this message. Please try again.")

            reply = final.get("reply") or {}
            view = booking_view(final.get("booking"))
            response = ChatResponse(
                conversation_id=body.conversation_id,
                request_id=request_id,
                response=reply.get("text") or "",
                intent=final.get("intent"),
                agent=reply.get("agent"),
                events=[EventCard(**e) for e in reply.get("events") or []],
                quick_replies=reply.get("quick_replies") or [],
                booking=view,
                seat_map=reply.get("seat_map"),
                faq_sources=reply.get("faq_sources") or [],
                error=reply.get("error"),
            )
            await store.add_message(
                body.conversation_id,
                "assistant",
                response.response,
                {
                    "intent": response.intent,
                    "agent": response.agent,
                    "events": [e.model_dump() for e in response.events],
                    "quick_replies": response.quick_replies,
                    "booking_stage": view.stage,
                    "ticket": view.ticket.model_dump() if view.ticket else None,
                    "faq_sources": response.faq_sources,
                    "error": response.error,
                },
            )
            await store.touch(body.conversation_id, message[:60])
    except ConversationBusy:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Still working on your previous message.")

    logger.info(
        "[CHAT] req=%s user=%s conv=%s intent=%s agent=%s stage=%s %.0fms",
        request_id, identity.user_id, body.conversation_id, response.intent, response.agent, view.stage,
        (time.perf_counter() - started) * 1000,
    )
    return response


# ── Conversations ────────────────────────────────────────────────────────────

@router.post("/conversations", response_model=ConversationCreated, status_code=status.HTTP_201_CREATED)
async def create_conversation(identity: Identity = Depends(get_identity)) -> ConversationCreated:
    conversation_id = f"conv_{uuid.uuid4().hex}"
    await get_store().create(conversation_id, identity.user_id, "New Chat")
    return ConversationCreated(conversation_id=conversation_id, title="New Chat")


@router.get("/conversations", response_model=ConversationList)
async def list_conversations(identity: Identity = Depends(get_identity)) -> ConversationList:
    items = await get_store().list_conversations(identity.user_id)
    return ConversationList(conversations=[ConversationSummary(**c) for c in items])


@router.get("/conversations/{conversation_id}/messages", response_model=ConversationMessages)
async def conversation_messages(conversation_id: str, identity: Identity = Depends(get_identity)) -> ConversationMessages:
    await _require_owner(conversation_id, identity)
    messages = await get_store().list_messages(conversation_id)
    state = await get_thread_state(identity.user_id, conversation_id)
    return ConversationMessages(
        conversation_id=conversation_id,
        messages=[StoredMessage(**m) for m in messages],
        booking=booking_view(state.get("booking")),
    )


@router.get("/conversations/{conversation_id}/state", response_model=ConversationState)
async def conversation_state(conversation_id: str, identity: Identity = Depends(get_identity)) -> ConversationState:
    """Authoritative booking state; refreshes an open payment from Node (e.g. after Stripe redirect)."""
    await _require_owner(conversation_id, identity)
    try:
        async with turn_lock.hold(f"{identity.user_id}::{conversation_id}"):
            state = await get_thread_state(identity.user_id, conversation_id)
            booking = dict(state.get("booking") or empty_booking())
            notice = None
            if booking.get("stage") == BookingStage.PAYMENT_PENDING.value and identity.token:
                try:
                    notice = await refresh_payment(booking, identity.token)
                except (NodeUnavailable, NodeAPIError) as exc:
                    logger.warning("Payment refresh failed: %s", exc)
                    notice = "Couldn't verify the payment status right now."
                else:
                    if booking.get("stage") != BookingStage.PAYMENT_PENDING.value:
                        await update_thread_state(identity.user_id, conversation_id, {"booking": booking})
                        if booking.get("stage") == BookingStage.COMPLETED.value:
                            notice = f"Payment verified — ticket {booking['ticket']['ticket_id']} is confirmed."
    except ConversationBusy:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Conversation is busy.")
    return ConversationState(conversation_id=conversation_id, booking=booking_view(booking), notice=notice)


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: str, identity: Identity = Depends(get_identity)) -> None:
    await _require_owner(conversation_id, identity)
    await delete_thread(identity.user_id, conversation_id)
    await get_store().delete(conversation_id)


@router.post("/conversations/{conversation_id}/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_conversation(conversation_id: str, identity: Identity = Depends(get_identity)) -> None:
    await _require_owner(conversation_id, identity)
    await delete_thread(identity.user_id, conversation_id)
    await get_store().clear_messages(conversation_id)
