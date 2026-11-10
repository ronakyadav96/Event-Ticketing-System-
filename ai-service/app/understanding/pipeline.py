"""The per-turn understanding entry point used by the graph's classify node."""

import logging
from typing import Any, Dict

from app.graph.state import Intent
from app.llm import LLMUnavailable
from app.understanding.fallback import degraded_classify, fast_classify
from app.understanding.rewrite import guess_language, needs_rewrite, rewrite
from app.understanding.tracker import track

logger = logging.getLogger(__name__)


async def understand(query: str, state: Dict[str, Any], facets: Dict[str, Any]) -> Dict[str, Any]:
    """
    Returns {intent, confidence, entities, source, standalone, language}.

    source: "rule" (UI phrase), "model" (rewrite + tracker), or "degraded" (model unavailable).
    """
    fast = fast_classify(query, state, facets)
    if fast:
        return {**fast, "standalone": query, "language": "english"}

    standalone, language = query, guess_language(query)
    if needs_rewrite(state):
        try:
            rewritten = await rewrite(query, state)
        except LLMUnavailable:
            rewritten = None  # the tracker still sees the raw message and the full context
        if rewritten:
            standalone, language = rewritten.standalone, rewritten.language
            logger.info("Rewrite %r → %r (%s, %s)", query, standalone, rewritten.scope, language)
            # Off-topic and small talk never reach the state tracker.
            base = {"source": "model", "standalone": standalone, "language": language}
            if rewritten.scope == "out_of_domain":
                return {**base, "intent": Intent.OUT_OF_DOMAIN.value, "confidence": 1.0, "entities": {}}
            if rewritten.scope == "small_talk":
                return {**base, "intent": Intent.SMALL_TALK.value, "confidence": 1.0, "entities": {}}

    try:
        tracked = await track(standalone, query, state, facets)
    except LLMUnavailable:
        return {**degraded_classify(query, state, facets), "standalone": standalone, "language": language}
    return {"source": "model", "standalone": standalone, "language": language, **tracked}
