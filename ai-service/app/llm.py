"""
LLM access for the two-model architecture (Claude by default, Gemini optional via LLM_PROVIDER).

- Model 1 (model_intent): fast structured understanding — intent, entities, references.
- Model 2 (model_generation): natural-language responses — small talk, search/detail
  narration from authoritative data, grounded FAQ answers.

Neither model ever decides whether a booking, payment or refund happened.
Failures raise LLMUnavailable; callers decide the controlled fallback.
"""

import asyncio
import logging
import time
from functools import lru_cache
from typing import Dict, Type, TypeVar

from pydantic import BaseModel

from config import settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

MAX_EXTRACT_TOKENS = 1024
MAX_GENERATE_TOKENS = 600


class LLMUnavailable(Exception):
    """The model is not configured, timed out, or returned an unusable result."""


# Circuit breaker: a model that just failed (quota exhausted, overloaded, timed out) is skipped
# for a cool-down period, so users get the instant fallback instead of waiting for every timeout.
_COOLDOWN_SECONDS = 60.0
_cooling_until: Dict[str, float] = {}


def _available(model_name: str) -> bool:
    return time.monotonic() >= _cooling_until.get(model_name, 0.0)


def _trip(model_name: str, exc: Exception) -> None:
    _cooling_until[model_name] = time.monotonic() + _COOLDOWN_SECONDS
    logger.warning("LLM model %s unavailable (%r); skipping it for %ds", model_name, exc, _COOLDOWN_SECONDS)


def reset_circuit() -> None:
    _cooling_until.clear()


# ── Claude (Anthropic SDK) ──────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _claude():
    import anthropic

    # One quick retry on 429/5xx/connection errors; our own wall-clock bound is asyncio.wait_for.
    return anthropic.AsyncAnthropic(
        api_key=settings.ANTHROPIC_API_KEY or None,
        max_retries=1,
        timeout=max(settings.LLM_TIMEOUT_SECONDS, settings.LLM_INTENT_TIMEOUT_SECONDS),
    )


def _claude_text(message) -> str:
    return "".join(block.text for block in message.content if getattr(block, "type", "") == "text").strip()


async def _claude_extract(model_name: str, schema: Type[T], system: str, user: str) -> T:
    response = await _claude().messages.parse(
        model=model_name,
        max_tokens=MAX_EXTRACT_TOKENS,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=schema,
    )
    parsed = response.parsed_output
    if not isinstance(parsed, schema):
        raise ValueError(f"no structured result (stop_reason={response.stop_reason})")
    return parsed


async def _claude_generate(model_name: str, system: str, user: str) -> str:
    response = await _claude().messages.create(
        model=model_name,
        max_tokens=MAX_GENERATE_TOKENS,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    if response.stop_reason == "refusal":
        raise ValueError("model declined the request")
    return _claude_text(response)


# ── Gemini (LangChain) ──────────────────────────────────────────────────────────

@lru_cache(maxsize=8)
def _gemini(model_name: str, temperature: float):
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=model_name,
        google_api_key=settings.gemini_api_key,
        temperature=temperature,
        max_retries=0,  # bounded latency; callers have explicit fallbacks
        # Gemini rejects request deadlines under 10s; our own bound is enforced by asyncio.wait_for.
        timeout=max(10.0, settings.LLM_TIMEOUT_SECONDS, settings.LLM_INTENT_TIMEOUT_SECONDS),
    )


async def _gemini_extract(model_name: str, schema: Type[T], system: str, user: str) -> T:
    result = await _gemini(model_name, 0.0).with_structured_output(schema).ainvoke([("system", system), ("human", user)])
    if not isinstance(result, schema):
        raise ValueError("no structured result")
    return result


async def _gemini_generate(model_name: str, system: str, user: str, temperature: float) -> str:
    message = await _gemini(model_name, temperature).ainvoke([("system", system), ("human", user)])
    content = message.content
    if isinstance(content, list):  # some Gemini versions return content parts
        content = "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
    return str(content or "").strip()


# ── Public API ──────────────────────────────────────────────────────────────────

def _require_configured() -> None:
    if not settings.llm_configured:
        raise LLMUnavailable(f"No API key configured for LLM provider {settings.llm_provider!r}")


async def extract(schema: Type[T], system: str, user: str) -> T:
    """Model 1: structured extraction into `schema`.

    A failed/slow call is retried once on the generation model (when it differs) before the
    caller falls back to degraded mode.
    """
    _require_configured()
    models = [settings.model_intent]
    if settings.model_generation not in models:
        models.append(settings.model_generation)
    last_error: Exception = LLMUnavailable("all models cooling down")
    for name in models:
        if not _available(name):
            continue
        try:
            call = (
                _gemini_extract(name, schema, system, user)
                if settings.llm_provider == "gemini"
                else _claude_extract(name, schema, system, user)
            )
            return await asyncio.wait_for(call, timeout=settings.LLM_INTENT_TIMEOUT_SECONDS)
        except Exception as exc:
            last_error = exc
            _trip(name, exc)
    raise LLMUnavailable(repr(last_error)) from last_error


async def generate(system: str, user: str, *, temperature: float = 0.4) -> str:
    """Model 2: free-text generation. `temperature` applies to Gemini only."""
    _require_configured()
    name = settings.model_generation
    if not _available(name):
        raise LLMUnavailable(f"{name} is cooling down")
    try:
        call = (
            _gemini_generate(name, system, user, temperature)
            if settings.llm_provider == "gemini"
            else _claude_generate(name, system, user)
        )
        text = await asyncio.wait_for(call, timeout=settings.LLM_TIMEOUT_SECONDS)
    except Exception as exc:
        _trip(name, exc)
        raise LLMUnavailable(str(exc)) from exc
    if not text:
        raise LLMUnavailable("Model 2 returned an empty response")
    return text
