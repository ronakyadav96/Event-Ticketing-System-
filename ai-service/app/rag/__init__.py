"""RAG layer for FAQ / policy documents (not the event catalog — that lives in MongoDB via Node)."""

from app.rag.retriever import get_index, retrieve

__all__ = ["get_index", "retrieve"]
