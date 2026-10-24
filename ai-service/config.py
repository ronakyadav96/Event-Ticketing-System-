"""
Central configuration for the AI service (pydantic-settings, loaded from ai-service/.env).

No secrets have defaults: a missing JWT secret makes every token fail verification
(fail closed) instead of silently accepting tokens signed with a well-known value.
"""

import os
from pathlib import Path
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_ROOT = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(SERVICE_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_ENV: str = "development"
    LOG_LEVEL: str = "INFO"

    # Comma-separated list of browser origins allowed to call the API.
    CORS_ORIGINS: str = "http://localhost:4200,http://127.0.0.1:4200"

    # Node.js / Express backend (authoritative for events, bookings, payments, refunds).
    NODE_BACKEND_BASE_URL: str = "http://localhost:5001"
    NODE_TIMEOUT_SECONDS: float = 10.0

    # Must equal the Node backend's JWT_SECRET; tokens are verified here and forwarded to Node.
    JWT_SECRET: Optional[str] = None

    # Persistence.
    POSTGRES_URL: Optional[str] = None
    REDIS_URL: Optional[str] = None
    # Explicit development-only fallback to in-process memory when Postgres/Redis are down.
    # Never enabled in production (see allow_memory_fallback).
    USE_IN_MEMORY_FALLBACK: bool = True

    # RAG.
    VECTOR_STORE_PATH: str = str(SERVICE_ROOT / "data" / "vectorstore")
    EMBEDDING_PROVIDER: str = "auto"  # auto | huggingface | builtin
    RAG_MIN_SCORE: float = 0.15
    RAG_TOP_K: int = 3

    # LLM provider: "anthropic" (Claude, default) or "gemini".
    # Model 1 = fast structured understanding, Model 2 = response generation.
    LLM_PROVIDER: str = "anthropic"
    ANTHROPIC_API_KEY: Optional[str] = None
    CLAUDE_MODEL_INTENT: str = "claude-haiku-4-5"
    CLAUDE_MODEL_GENERATION: str = "claude-haiku-4-5"

    # Gemini (used when LLM_PROVIDER=gemini).
    GEMINI_API_KEY: Optional[str] = None
    GOOGLE_API_KEY: Optional[str] = None
    GEMINI_MODEL_INTENT: str = "gemini-flash-lite-latest"
    GEMINI_MODEL_GENERATION: str = "gemini-flash-latest"

    LLM_TIMEOUT_SECONDS: float = 8.0          # Model 2 (wording has deterministic fallbacks)
    LLM_INTENT_TIMEOUT_SECONDS: float = 15.0  # Model 1 (understanding is required to act)

    # Time zone the Node backend uses for show dates/times (must match Node's EVENT_TIMEZONE).
    EVENT_TIMEZONE: str = "Asia/Kolkata"

    # "app": booking requests open the event's booking page in the web app (seat map, payment).
    # "chat": the step-by-step booking flow runs inside the chat.
    CHAT_BOOKING_MODE: str = "app"

    # Only checkout URLs on these prefixes are ever shown to the user.
    PAYMENT_URL_PREFIXES: str = "https://checkout.stripe.com/"

    @property
    def is_production(self) -> bool:
        return self.APP_ENV.lower() == "production"

    @property
    def allow_memory_fallback(self) -> bool:
        return self.USE_IN_MEMORY_FALLBACK and not self.is_production

    @property
    def llm_provider(self) -> str:
        return "gemini" if self.LLM_PROVIDER.strip().lower() == "gemini" else "anthropic"

    @property
    def llm_configured(self) -> bool:
        if self.llm_provider == "gemini":
            return bool(self.gemini_api_key)
        return bool(self.ANTHROPIC_API_KEY or os.environ.get("ANTHROPIC_API_KEY"))

    @property
    def model_intent(self) -> str:
        return self.GEMINI_MODEL_INTENT if self.llm_provider == "gemini" else self.CLAUDE_MODEL_INTENT

    @property
    def model_generation(self) -> str:
        return self.GEMINI_MODEL_GENERATION if self.llm_provider == "gemini" else self.CLAUDE_MODEL_GENERATION

    @property
    def gemini_api_key(self) -> Optional[str]:
        return self.GEMINI_API_KEY or self.GOOGLE_API_KEY

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def vector_store_dir(self) -> Path:
        # Relative paths are resolved against the service root, never the process CWD.
        path = Path(self.VECTOR_STORE_PATH)
        return path if path.is_absolute() else SERVICE_ROOT / path

    @property
    def payment_url_prefixes(self) -> List[str]:
        return [p.strip() for p in self.PAYMENT_URL_PREFIXES.split(",") if p.strip()]


settings = Settings()
