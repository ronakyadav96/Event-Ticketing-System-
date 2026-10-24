"""FAQ / policy retrieval tool. Retrieved text is treated as untrusted data."""

import re
from typing import Any, Dict, List

from app.rag import retrieve

# Lines in retrieved documents that look like instructions to the model are dropped before
# the text reaches the generation prompt (defence in depth on top of the prompt rules).
_INJECTION_LINE = re.compile(
    r"(ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above)\s+instructions|system\s+prompt|"
    r"you\s+are\s+now|disregard\s+.*instructions|act\s+as\s+|developer\s+mode|jailbreak)",
    re.IGNORECASE,
)


def _sanitize(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not _INJECTION_LINE.search(line)).strip()


def search_knowledge(query: str) -> List[Dict[str, Any]]:
    """Relevant policy passages: [{text, source, section, score}], best first. Empty if none relevant."""
    passages = []
    for doc, score in retrieve(query):
        text = _sanitize(doc.page_content)
        if text:
            passages.append(
                {
                    "text": text,
                    "source": doc.metadata.get("source"),
                    "title": doc.metadata.get("title"),
                    "section": doc.metadata.get("section"),
                    "score": score,
                }
            )
    return passages
