"""Health endpoint reporting real dependency status (no fake 'healthy')."""

from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from config import settings
from db import get_store
from db.postgres import PostgresConversationStore
from db.redis_client import ping as redis_ping
from services.node_client import NodeUnavailable, node_client

router = APIRouter()


@router.get("/health")
async def health() -> JSONResponse:
    checks: Dict[str, Any] = {}

    try:
        store = get_store()
        checks["conversation_store"] = "postgres" if isinstance(store, PostgresConversationStore) else "memory (development)"
        if isinstance(store, PostgresConversationStore):
            await store.list_conversations("__healthcheck__")
    except Exception as exc:
        checks["conversation_store"] = f"error: {exc}"

    redis_error = await redis_ping()
    checks["redis"] = "ok" if redis_error is None else redis_error

    try:
        await node_client.get_facets()
        checks["node_backend"] = "ok"
    except NodeUnavailable as exc:
        checks["node_backend"] = f"unavailable: {exc}"
    except Exception as exc:
        checks["node_backend"] = f"error: {exc}"

    checks["gemini"] = "configured" if settings.gemini_api_key else "not configured"
    checks["models"] = {"intent": settings.GEMINI_MODEL_INTENT, "generation": settings.GEMINI_MODEL_GENERATION}

    healthy = checks["node_backend"] == "ok" and not str(checks["conversation_store"]).startswith("error")
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={
            "status": "ok" if healthy else "degraded",
            "environment": settings.APP_ENV,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "checks": checks,
        },
    )
