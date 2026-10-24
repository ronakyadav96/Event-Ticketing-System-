"""
LangGraph nodes:

    hydrate → classify → (route) → guardrail | search | booking | refund | faq → validate

Identity and the user's JWT come from the verified request through the run config
(`configurable`), never from checkpointed state or the client body; the JWT is never
written to the checkpoint.
"""

import logging
from typing import Any, Dict, List

from langchain_core.messages import AIMessage, RemoveMessage
from langchain_core.runnables import RunnableConfig

from app.agents import booking as booking_agent
from app.agents import faq as faq_agent
from app.agents import guardrail
from app.agents import refund as refund_agent
from app.agents import search as search_agent
from app.agents.intent import classify
from app.graph.state import (
    ACTIVE_BOOKING_STAGES,
    AgentState,
    BookingStage,
    Intent,
    empty_booking,
    empty_refund,
    empty_search,
)
from app.tools import catalog as catalog_tools

logger = logging.getLogger(__name__)

MAX_STORED_MESSAGES = 40

ROUTES = {
    Intent.SMALL_TALK.value: "guardrail",
    Intent.OUT_OF_DOMAIN.value: "guardrail",
    Intent.UNKNOWN.value: "guardrail",
    Intent.EVENT_SEARCH.value: "search",
    Intent.EVENT_DETAILS.value: "search",
    Intent.BOOKING.value: "booking",
    Intent.BOOKING_STATUS.value: "booking",
    Intent.CANCEL_BOOKING.value: "refund",
    Intent.REFUND.value: "refund",
    Intent.REFUND_STATUS.value: "refund",
    Intent.FAQ_POLICY.value: "faq",
}


def _cfg(config: RunnableConfig) -> Dict[str, Any]:
    return (config or {}).get("configurable") or {}


def _latest_user_text(state: AgentState) -> str:
    for msg in reversed(state.get("messages") or []):
        if getattr(msg, "type", "") == "human":
            return str(msg.content)
    return ""


def _recent_pairs(state: AgentState, limit: int = 6) -> List[tuple]:
    pairs = []
    for msg in (state.get("messages") or [])[-limit:]:
        pairs.append(("user" if msg.type == "human" else "assistant", str(msg.content)[:300]))
    return pairs


async def hydrate_node(state: AgentState, config: RunnableConfig) -> Dict[str, Any]:
    cfg = _cfg(config)
    return {
        "user_id": cfg["user_id"],
        "user_name": cfg.get("user_name"),
        "is_authenticated": bool(cfg.get("is_authenticated")),
        "search": state.get("search") or empty_search(),
        "booking": state.get("booking") or empty_booking(),
        "refund": state.get("refund") or empty_refund(),
        "intent": None,
        "confidence": None,
        "entities": {},
        "route": None,
        "reply": {},
    }


async def classify_node(state: AgentState) -> Dict[str, Any]:
    query = _latest_user_text(state)
    violation = guardrail.check_input(query)
    if violation:
        return {"intent": Intent.OUT_OF_DOMAIN.value, "confidence": 1.0, "entities": {"guard": violation}}

    facets = await catalog_tools.get_facets()
    result = await classify(query, state, facets)
    entities = dict(result["entities"])
    entities["_source"] = result["source"]
    logger.info("Intent %s (%.2f, %s)", result["intent"], result["confidence"], result["source"])
    return {"intent": result["intent"], "confidence": result["confidence"], "entities": entities}


def route_node(state: AgentState) -> Dict[str, Any]:
    """Supervisor: one deterministic mapping from the classified intent to a domain agent."""
    intent = state.get("intent") or Intent.UNKNOWN.value
    entities = dict(state.get("entities") or {})
    route = "guardrail" if entities.get("guard") else ROUTES.get(intent, "guardrail")

    booking_stage = (state.get("booking") or {}).get("stage", BookingStage.IDLE.value)
    in_draft = BookingStage(booking_stage) in ACTIVE_BOOKING_STAGES
    # "Cancel" while a draft booking is open (and no ticket named) abandons the draft.
    if intent == Intent.CANCEL_BOOKING.value and in_draft and not entities.get("ticket_id") and (
        (state.get("refund") or {}).get("stage") != "AWAITING_CONFIRMATION"
    ):
        route = "booking"
        entities["cancel_draft"] = True

    update: Dict[str, Any] = {"route": route, "entities": entities}
    # A pending refund question only stays open while the user is answering it.
    if route != "refund" and (state.get("refund") or {}).get("stage") != "IDLE":
        update["refund"] = empty_refund()
    return update


def pick_route(state: AgentState) -> str:
    return state.get("route") or "guardrail"


async def guardrail_node(state: AgentState) -> Dict[str, Any]:
    entities = state.get("entities") or {}
    intent = state.get("intent")
    if entities.get("guard"):
        reply = guardrail.safety_reply(entities["guard"])
    elif intent == Intent.SMALL_TALK.value:
        reply = await guardrail.small_talk_reply(_latest_user_text(state), state.get("user_name"), _recent_pairs(state))
    elif intent == Intent.OUT_OF_DOMAIN.value:
        reply = guardrail.out_of_domain_reply()
    else:
        reply = guardrail.unknown_reply(degraded=entities.get("_source") == "degraded")
    return {"reply": reply}


async def search_node(state: AgentState) -> Dict[str, Any]:
    query = _latest_user_text(state)
    entities = state.get("entities") or {}
    if state.get("intent") == Intent.EVENT_DETAILS.value:
        reply, search = await search_agent.run_details(state, entities, query)
    else:
        reply, search = await search_agent.run_search(state, entities, query)
    return {"reply": reply, "search": search}


async def booking_node(state: AgentState, config: RunnableConfig) -> Dict[str, Any]:
    cfg = _cfg(config)
    entities = state.get("entities") or {}
    if state.get("intent") == Intent.BOOKING_STATUS.value:
        reply, booking = await booking_agent.run_booking_status(state, entities, token=cfg.get("auth_token"))
        return {"reply": reply, "booking": booking}
    reply, booking, search = await booking_agent.run_booking(
        state, entities, token=cfg.get("auth_token"), is_authenticated=bool(cfg.get("is_authenticated"))
    )
    return {"reply": reply, "booking": booking, "search": search}


async def refund_node(state: AgentState, config: RunnableConfig) -> Dict[str, Any]:
    reply, refund = await refund_agent.run_refund(
        state, state.get("intent") or "", state.get("entities") or {}, token=_cfg(config).get("auth_token")
    )
    return {"reply": reply, "refund": refund}


async def faq_node(state: AgentState) -> Dict[str, Any]:
    return {"reply": await faq_agent.run_faq(_latest_user_text(state))}


async def validate_node(state: AgentState) -> Dict[str, Any]:
    """Last line of defence before the reply leaves the graph."""
    reply = dict(state.get("reply") or {})
    route = state.get("route")
    catalog = (state.get("search") or {}).get("catalog") or {}

    if not str(reply.get("text") or "").strip():
        reply = guardrail.unknown_reply(degraded=False)

    # Event cards only from authoritative, already-recorded catalog entries, and never on
    # guardrail / FAQ / refund turns.
    if route in ("search", "booking"):
        reply["events"] = [catalog[e["id"]] for e in reply.get("events") or [] if e.get("id") in catalog]
    else:
        reply["events"] = []
    if route != "booking":
        reply["seat_map"] = None

    update: Dict[str, Any] = {"reply": reply, "messages": [AIMessage(content=reply["text"])]}

    messages = state.get("messages") or []
    overflow = len(messages) + 1 - MAX_STORED_MESSAGES
    if overflow > 0:
        update["messages"] = [RemoveMessage(id=m.id) for m in messages[:overflow] if m.id] + update["messages"]
    return update
