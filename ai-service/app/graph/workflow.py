"""
Graph assembly, checkpointer lifecycle and the per-turn entry point.

Checkpoints are keyed by thread_id = "<user_id>::<conversation_id>", so state can only be
loaded by the user who owns the conversation (ownership is also checked in the API layer).
"""

import logging
from typing import Any, Dict, Optional

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.graph.nodes import (
    booking_node,
    classify_node,
    faq_node,
    guardrail_node,
    hydrate_node,
    pick_route,
    refund_node,
    route_node,
    search_node,
    validate_node,
)
from app.graph.state import AgentState
from config import settings
from db.postgres import psycopg_conninfo

logger = logging.getLogger(__name__)

_checkpointer: Optional[Any] = None
_pool: Optional[Any] = None
_graph: Optional[Any] = None


def thread_id_for(user_id: str, conversation_id: str) -> str:
    return f"{user_id}::{conversation_id}"


def build_graph(checkpointer: Any):
    g = StateGraph(AgentState)
    g.add_node("hydrate", hydrate_node)
    g.add_node("classify", classify_node)
    g.add_node("route", route_node)
    g.add_node("guardrail", guardrail_node)
    g.add_node("search", search_node)
    g.add_node("booking", booking_node)
    g.add_node("refund", refund_node)
    g.add_node("faq", faq_node)
    g.add_node("validate", validate_node)

    g.add_edge(START, "hydrate")
    g.add_edge("hydrate", "classify")
    g.add_edge("classify", "route")
    g.add_conditional_edges(
        "route",
        pick_route,
        {"guardrail": "guardrail", "search": "search", "booking": "booking", "refund": "refund", "faq": "faq"},
    )
    for node in ("guardrail", "search", "booking", "refund", "faq"):
        g.add_edge(node, "validate")
    g.add_edge("validate", END)
    return g.compile(checkpointer=checkpointer)


async def init_checkpointer() -> Any:
    """Postgres checkpointer; MemorySaver only as an explicit development fallback."""
    global _checkpointer, _pool, _graph
    if _checkpointer is not None:
        return _checkpointer

    conninfo = psycopg_conninfo()
    if conninfo:
        try:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
            from psycopg_pool import AsyncConnectionPool

            pool = AsyncConnectionPool(conninfo=conninfo, max_size=10, kwargs={"autocommit": True, "prepare_threshold": 0}, open=False)
            try:
                await pool.open(wait=True, timeout=5)
                saver = AsyncPostgresSaver(pool)
                await saver.setup()
            except Exception:
                await pool.close()  # stop the pool's background reconnect attempts
                raise
            _pool, _checkpointer = pool, saver
            logger.info("LangGraph checkpointer: PostgreSQL")
        except Exception as exc:
            if not settings.allow_memory_fallback:
                raise
            logger.warning("PostgreSQL checkpointer unavailable (%s); using in-memory checkpointer (development only).", exc)
    elif not settings.allow_memory_fallback:
        raise RuntimeError("POSTGRES_URL is required in production")

    if _checkpointer is None:
        _checkpointer = MemorySaver()
        logger.warning("LangGraph checkpointer: in-memory (state is lost on restart)")
    _graph = build_graph(_checkpointer)
    return _checkpointer


async def close_checkpointer() -> None:
    global _checkpointer, _pool, _graph
    if _pool is not None:
        await _pool.close()
    _checkpointer = _pool = _graph = None


async def _get_graph():
    if _graph is None:
        await init_checkpointer()
    return _graph


async def run_turn(
    *,
    query: str,
    conversation_id: str,
    user_id: str,
    user_name: Optional[str],
    is_authenticated: bool,
    auth_token: Optional[str],
    city: Optional[str] = None,
) -> Dict[str, Any]:
    graph = await _get_graph()
    config = {
        "configurable": {
            "thread_id": thread_id_for(user_id, conversation_id),
            "user_id": user_id,
            "user_name": user_name,
            "is_authenticated": is_authenticated,
            "auth_token": auth_token,
            "city": city,
        }
    }
    return await graph.ainvoke({"messages": [HumanMessage(content=query)]}, config=config)


async def get_thread_state(user_id: str, conversation_id: str) -> Dict[str, Any]:
    graph = await _get_graph()
    snapshot = await graph.aget_state({"configurable": {"thread_id": thread_id_for(user_id, conversation_id)}})
    return dict(snapshot.values or {})


async def update_thread_state(user_id: str, conversation_id: str, values: Dict[str, Any]) -> None:
    graph = await _get_graph()
    await graph.aupdate_state(
        {"configurable": {"thread_id": thread_id_for(user_id, conversation_id)}}, values, as_node="validate"
    )


async def delete_thread(user_id: str, conversation_id: str) -> None:
    cp = _checkpointer or await init_checkpointer()
    tid = thread_id_for(user_id, conversation_id)
    if hasattr(cp, "adelete_thread"):
        await cp.adelete_thread(tid)
    elif hasattr(cp, "delete_thread"):
        cp.delete_thread(tid)
