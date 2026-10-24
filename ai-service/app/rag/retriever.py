"""FAQ / policy retriever over the persistent vector index (built or refreshed on first use)."""

import logging
from typing import List, Optional, Tuple

from langchain_core.documents import Document

from app.rag.ingestion import docs_fingerprint, load_chunks
from app.rag.vector_store import VectorIndex, embedding_id, get_embeddings
from config import settings

logger = logging.getLogger(__name__)

_index: Optional[VectorIndex] = None


def get_index() -> VectorIndex:
    global _index
    if _index is None:
        embeddings = get_embeddings()
        directory = settings.vector_store_dir
        fingerprint = docs_fingerprint()
        index = VectorIndex.load(embeddings, directory, fingerprint)
        if index is None:
            chunks = load_chunks()
            index = VectorIndex.build(embeddings, chunks, fingerprint)
            index.save(directory)
            logger.info("Built FAQ index: %d chunks (%s) at %s", index.count(), embedding_id(embeddings), directory)
        _index = index
    return _index


def retrieve(query: str, top_k: Optional[int] = None) -> List[Tuple[Document, float]]:
    """Top-k chunks with scores, filtered by the configured minimum relevance."""
    results = get_index().search(query, top_k or settings.RAG_TOP_K)
    return [(doc, score) for doc, score in results if score >= settings.RAG_MIN_SCORE]
