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
from typing import Dict, List, Optional, Type, TypeVar

from pydantic import BaseModel

from config import settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class LLMUnavailable(Exception):
    """Gemini is not configured, timed out, or returned an unusable result."""


# Circuit breaker: a model that just failed is skipped for a cool-down period, so users get the
# next model (or the instant fallback) instead of waiting for every timeout. Exhausted quota
# (429) lasts about a minute and a model too slow for our timeout stays slow for a while;
# overload (503) is usually brief.
_COOLDOWN_SECONDS = 60.0
_SLOW_COOLDOWN_SECONDS = 120.0
_TRANSIENT_COOLDOWN_SECONDS = 15.0
_cooling_until: Dict[str, float] = {}


def _available(model_name: str) -> bool:
    return time.monotonic() >= _cooling_until.get(model_name, 0.0)


def _trip(model_name: str, exc: Exception) -> None:
    text = repr(exc)
    if "429" in text or "RESOURCE_EXHAUSTED" in text:
        seconds = _COOLDOWN_SECONDS
    elif isinstance(exc, asyncio.TimeoutError):
        seconds = _SLOW_COOLDOWN_SECONDS
    else:
        seconds = _TRANSIENT_COOLDOWN_SECONDS
    _cooling_until[model_name] = time.monotonic() + seconds
    logger.warning("Gemini model %s unavailable (%s); skipping it for %ds", model_name, text[:300], seconds)


def reset_circuit() -> None:
    _cooling_until.clear()


def _chain(first: str) -> List[str]:
    """`first`, then one other configured model (each has its own free-tier quota); two
    attempts at most keep the worst-case latency bounded."""
    names = [first, settings.GEMINI_MODEL_REWRITE, settings.GEMINI_MODEL_INTENT, settings.GEMINI_MODEL_GENERATION]
    return list(dict.fromkeys(n for n in names if n))[:2]


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


async def _extract_once(model_name: str, schema: Type[T], system: str, user: str, timeout: float) -> T:
    model = _chat_model(model_name, 0.0).with_structured_output(schema)
    result = await asyncio.wait_for(model.ainvoke([("system", system), ("human", user)]), timeout=timeout)
    if not isinstance(result, schema):
        raise ValueError("no structured result")
    return result


async def extract(
    schema: Type[T], system: str, user: str, *, models: Optional[List[str]] = None, timeout: Optional[float] = None
) -> T:
    """Model 1: structured extraction into `schema`.

    By default a failed/slow call is retried on the other configured models before the caller
    falls back to degraded mode. Callers with their own fallback pass a single model.
    """
    if models is None:
        models = _chain(settings.GEMINI_MODEL_INTENT)
    timeout = timeout or settings.GEMINI_INTENT_TIMEOUT_SECONDS
    last_error: Exception = LLMUnavailable("all models cooling down")
    for name in models:
        if not _available(name):
            continue
        try:
            return await _extract_once(name, schema, system, user, timeout)
        except LLMUnavailable:
            raise
        except Exception as exc:
            last_error = exc
            _trip(name, exc)
    raise LLMUnavailable(repr(last_error)) from last_error


async def generate(system: str, user: str, *, temperature: float = 0.4) -> str:
    """Model 2: free-text generation, falling back to the other configured models."""
    last_error: Exception = LLMUnavailable("all models cooling down")
    for name in _chain(settings.GEMINI_MODEL_GENERATION):
        if not _available(name):
            continue
        try:
            model = _chat_model(name, temperature)
            message = await asyncio.wait_for(
                model.ainvoke([("system", system), ("human", user)]),
                timeout=settings.GEMINI_TIMEOUT_SECONDS,
            )
        except LLMUnavailable:
            raise
        except Exception as exc:
            last_error = exc
            _trip(name, exc)
            continue
        text = _text(message.content)
        if text:
            return text
        last_error = LLMUnavailable(f"{name} returned an empty response")
    raise LLMUnavailable(str(last_error)) from last_error


def _text(content) -> str:
    if isinstance(content, list):  # Gemini 3 returns content parts
        content = "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
    return str(content or "").strip()
