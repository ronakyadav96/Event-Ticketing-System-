"""FastAPI application: lifespan (storage, locks, checkpointer, RAG index) and routing."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import chat_router, health_router
from app.graph.workflow import close_checkpointer, init_checkpointer
from app.rag import get_index
from config import settings
from db import StoreUnavailable, close_store, init_store, turn_lock
from services.node_client import node_client

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ai_service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting AI service (env=%s)", settings.APP_ENV)
    if not settings.JWT_SECRET:
        logger.error("JWT_SECRET is not set: authenticated requests will be rejected.")
    if not settings.llm_configured:
        logger.error("No API key for LLM provider %r: the assistant runs in degraded mode.", settings.llm_provider)
    else:
        logger.info("LLM provider: %s (intent=%s, generation=%s)", settings.llm_provider, settings.model_intent, settings.model_generation)
    await init_store()
    await turn_lock.connect()
    await init_checkpointer()
    try:
        logger.info("FAQ index ready (%d chunks)", get_index().count())
    except Exception as exc:
        logger.error("FAQ index failed to load: %s", exc)
    yield
    await close_checkpointer()
    await turn_lock.close()
    await close_store()
    await node_client.close()


def create_app() -> FastAPI:
    app = FastAPI(title="Event AI Service", version="2.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Guest-Id", "X-Request-ID"],
    )

    @app.exception_handler(StoreUnavailable)
    async def _store_unavailable(_: Request, __: StoreUnavailable) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "Conversation storage is unavailable."})

    app.include_router(health_router)
    app.include_router(health_router, prefix="/api/v1")
    app.include_router(chat_router, prefix="/api/v1")
    return app


app = create_app()
