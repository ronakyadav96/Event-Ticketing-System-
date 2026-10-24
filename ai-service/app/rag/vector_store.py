"""
Embeddings and the persistent vector index for FAQ / policy retrieval.

The index records which embedding model built it and a fingerprint of the source
documents; a mismatch on load triggers a rebuild, so query vectors and stored vectors
always come from the same model.
"""

import json
import logging
import math
import re
import zlib
from pathlib import Path
from typing import List, Optional, Tuple

from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings

from config import settings

logger = logging.getLogger(__name__)

INDEX_FILE = "index.json"
INDEX_VERSION = 2

_STOP_WORDS = {
    "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "of", "with", "by", "is",
    "are", "was", "were", "be", "this", "that", "it", "from", "as", "if", "into", "all", "can",
    "my", "your", "what", "how", "when", "where", "do", "does", "you", "we", "i", "me", "there",
    "any", "some", "will", "about", "get", "have", "has",
}


def tokenize(text: str) -> List[str]:
    return [t for t in re.sub(r"[^\w\s]", " ", text.lower()).split() if t and t not in _STOP_WORDS]


class HashingEmbeddings(Embeddings):
    """Offline, dependency-free embeddings: hashed unigrams, bigrams and 4-char prefixes."""

    DIMENSION = 384
    model_id = "builtin-hashing-v1"

    def _embed(self, text: str) -> List[float]:
        vec = [0.0] * self.DIMENSION
        tokens = tokenize(text)
        features: List[Tuple[str, float]] = []
        for i, t in enumerate(tokens):
            features.append((t, 1.0))
            if len(t) >= 5:
                features.append((f"p:{t[:5]}", 0.6))
            if i + 1 < len(tokens):
                features.append((f"{t}_{tokens[i + 1]}", 1.2))
        for feat, weight in features:
            h = zlib.crc32(feat.encode("utf-8"))
            vec[h % self.DIMENSION] += weight if (h >> 16) & 1 == 0 else -weight
        norm = math.sqrt(sum(v * v for v in vec))
        return [v / norm for v in vec] if norm > 1e-9 else vec

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return [self._embed(t) for t in texts]

    def embed_query(self, text: str) -> List[float]:
        return self._embed(text)


def get_embeddings() -> Embeddings:
    """Configured embeddings. `auto` prefers a local sentence-transformers model when installed."""
    provider = settings.EMBEDDING_PROVIDER.lower()
    if provider in ("auto", "huggingface"):
        try:
            from langchain_community.embeddings import HuggingFaceEmbeddings

            emb = HuggingFaceEmbeddings(
                model_name="sentence-transformers/all-MiniLM-L6-v2",
                encode_kwargs={"normalize_embeddings": True},
            )
            emb.embed_query("warmup")
            setattr(emb, "model_id", "hf-all-MiniLM-L6-v2")
            return emb
        except Exception as exc:
            if provider == "huggingface":
                raise
            logger.info("Local sentence-transformers embeddings unavailable (%s); using built-in embeddings.", exc)
    return HashingEmbeddings()


def embedding_id(emb: Embeddings) -> str:
    return getattr(emb, "model_id", type(emb).__name__)


class VectorIndex:
    """In-memory vector index persisted as JSON. Hybrid score = dense cosine + lexical overlap."""

    def __init__(self, embeddings: Embeddings, documents: List[Document], vectors: List[List[float]], fingerprint: str):
        self.embeddings = embeddings
        self.documents = documents
        self.vectors = vectors
        self.fingerprint = fingerprint

    def count(self) -> int:
        return len(self.documents)

    @classmethod
    def build(cls, embeddings: Embeddings, documents: List[Document], fingerprint: str) -> "VectorIndex":
        vectors = embeddings.embed_documents([d.page_content for d in documents]) if documents else []
        return cls(embeddings, documents, vectors, fingerprint)

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        data = {
            "version": INDEX_VERSION,
            "embedding_id": embedding_id(self.embeddings),
            "fingerprint": self.fingerprint,
            "documents": [{"page_content": d.page_content, "metadata": d.metadata} for d in self.documents],
            "vectors": self.vectors,
        }
        (directory / INDEX_FILE).write_text(json.dumps(data), encoding="utf-8")

    @classmethod
    def load(cls, embeddings: Embeddings, directory: Path, fingerprint: str) -> Optional["VectorIndex"]:
        path = directory / INDEX_FILE
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if (
            data.get("version") != INDEX_VERSION
            or data.get("embedding_id") != embedding_id(embeddings)
            or data.get("fingerprint") != fingerprint
        ):
            return None
        docs = [Document(page_content=d["page_content"], metadata=d.get("metadata", {})) for d in data["documents"]]
        return cls(embeddings, docs, data["vectors"], fingerprint)

    def search(self, query: str, k: int) -> List[Tuple[Document, float]]:
        if not self.documents or not query.strip():
            return []
        q_vec = self.embeddings.embed_query(query)
        q_tokens = set(tokenize(query))
        results: List[Tuple[Document, float]] = []
        for doc, vec in zip(self.documents, self.vectors):
            dense = sum(a * b for a, b in zip(q_vec, vec))
            if q_tokens:
                doc_tokens = set(tokenize(doc.page_content))
                stems = {t[:5] for t in doc_tokens}
                hits = sum(1 for t in q_tokens if t in doc_tokens or t[:5] in stems)
                lexical = hits / len(q_tokens)
            else:
                lexical = 0.0
            score = 0.6 * max(dense, 0.0) + 0.4 * lexical
            results.append((doc, round(score, 4)))
        results.sort(key=lambda item: item[1], reverse=True)
        return results[:k]
