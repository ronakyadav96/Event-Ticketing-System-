"""
Gemini access for the two-model architecture.

- Model 1 (GEMINI_MODEL_INTENT): fast structured understanding — intent, entities, references.
- Model 2 (GEMINI_MODEL_GENERATION): natural-language responses — small talk, search/detail
  narration from authoritative data, grounded FAQ answers.

Neither model ever decides whether a booking, payment or refund happened.
Failures raise LLMUnavailable; callers decide the controlled fallback.
"""

import asyncio
import logging
import time
from functools import lru_cache
from typing import Dict
from typing import Type, TypeVar

from pydantic import BaseModel

from config import settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class LLMUnavailable(Exception):
    """Gemini is not configured, timed out, or returned an unusable result."""


# Circuit breaker: a model that just failed (quota exhausted, overloaded, timed out) is skipped
# for a cool-down period, so users get the instant fallback instead of waiting for every timeout.
_COOLDOWN_SECONDS = 60.0
_cooling_until: Dict[str, float] = {}


def _available(model_name: str) -> bool:
    return time.monotonic() >= _cooling_until.get(model_name, 0.0)


def _trip(model_name: str, exc: Exception) -> None:
    _cooling_until[model_name] = time.monotonic() + _COOLDOWN_SECONDS
    logger.warning("Gemini model %s unavailable (%r); skipping it for %ds", model_name, exc, _COOLDOWN_SECONDS)


def reset_circuit() -> None:
    _cooling_until.clear()


@lru_cache(maxsize=8)
def _chat_model(model_name: str, temperature: float):
    if not settings.gemini_api_key:
        raise LLMUnavailable("GEMINI_API_KEY is not configured")
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=model_name,
        google_api_key=settings.gemini_api_key,
        temperature=temperature,
        max_retries=0,  # bounded latency; callers have explicit fallbacks
        # Gemini rejects request deadlines under 10s; our own bound is enforced by asyncio.wait_for.
        timeout=max(10.0, settings.GEMINI_TIMEOUT_SECONDS, settings.GEMINI_INTENT_TIMEOUT_SECONDS),
    )


async def _extract_once(model_name: str, schema: Type[T], system: str, user: str) -> T:
    model = _chat_model(model_name, 0.0).with_structured_output(schema)
    result = await asyncio.wait_for(
        model.ainvoke([("system", system), ("human", user)]),
        timeout=settings.GEMINI_INTENT_TIMEOUT_SECONDS,
    )
    if not isinstance(result, schema):
        raise ValueError("no structured result")
    return result


async def extract(schema: Type[T], system: str, user: str) -> T:
    """Model 1: structured extraction into `schema`.

    Gemini latency spikes are common, so a failed/slow call is retried once on the
    generation model before the caller falls back to degraded mode.
    """
    models = [settings.GEMINI_MODEL_INTENT]
    if settings.GEMINI_MODEL_GENERATION not in models:
        models.append(settings.GEMINI_MODEL_GENERATION)
    last_error: Exception = LLMUnavailable("all models cooling down")
    for name in models:
        if not _available(name):
            continue
        try:
            return await _extract_once(name, schema, system, user)
        except LLMUnavailable:
            raise
        except Exception as exc:
            last_error = exc
            _trip(name, exc)
    raise LLMUnavailable(repr(last_error)) from last_error


async def generate(system: str, user: str, *, temperature: float = 0.4) -> str:
    """Model 2: free-text generation."""
    name = settings.GEMINI_MODEL_GENERATION
    if not _available(name):
        raise LLMUnavailable(f"{name} is cooling down")
    try:
        model = _chat_model(name, temperature)
        message = await asyncio.wait_for(
            model.ainvoke([("system", system), ("human", user)]),
            timeout=settings.GEMINI_TIMEOUT_SECONDS,
        )
    except LLMUnavailable:
        raise
    except Exception as exc:
        _trip(name, exc)
        raise LLMUnavailable(str(exc)) from exc

    content = message.content
    if isinstance(content, list):  # some Gemini versions return content parts
        content = "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
    text = str(content or "").strip()
    if not text:
        raise LLMUnavailable("Model 2 returned an empty response")
    return text
