"""
Loads the FAQ / policy markdown documents and splits them into section-level chunks.

Each chunk is one "## " section (split further by paragraph if long) prefixed with the
document title and section heading, so every chunk is self-describing for retrieval and
for citation in grounded answers.
"""

import hashlib
import re
from pathlib import Path
from typing import List, Tuple

from langchain_core.documents import Document

DOCS_DIR = Path(__file__).resolve().parent / "docs"
MAX_CHUNK_CHARS = 1200


def docs_fingerprint(docs_dir: Path = DOCS_DIR) -> str:
    digest = hashlib.sha256(f"chunker-v2:{MAX_CHUNK_CHARS}".encode())
    for path in sorted(docs_dir.glob("*.md")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _split_sections(content: str) -> Tuple[str, List[Tuple[str, str]]]:
    title_match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else ""
    sections: List[Tuple[str, str]] = []
    parts = re.split(r"^##\s+", content, flags=re.MULTILINE)
    for part in parts[1:]:
        heading, _, body = part.partition("\n")
        body = body.strip()
        if body:
            sections.append((heading.strip(), body))
    if not sections:
        body = re.sub(r"^#\s+.+$", "", content, count=1, flags=re.MULTILINE).strip()
        if body:
            sections.append(("", body))
    return title, sections


def _split_long(body: str) -> List[str]:
    if len(body) <= MAX_CHUNK_CHARS:
        return [body]
    chunks: List[str] = []
    current = ""
    for para in re.split(r"\n\s*\n", body):
        candidate = f"{current}\n\n{para}".strip() if current else para
        if len(candidate) <= MAX_CHUNK_CHARS or not current:
            current = candidate
        else:
            chunks.append(current)
            current = para
    if current:
        chunks.append(current)
    return chunks


def load_chunks(docs_dir: Path = DOCS_DIR) -> List[Document]:
    chunks: List[Document] = []
    for path in sorted(docs_dir.glob("*.md")):
        title, sections = _split_sections(path.read_text(encoding="utf-8"))
        title = title or path.stem.replace("_", " ").title()
        for heading, body in sections:
            for i, piece in enumerate(_split_long(body)):
                header = f"{title} — {heading}" if heading else title
                chunks.append(
                    Document(
                        page_content=f"{header}\n{piece}",
                        metadata={"source": path.name, "title": title, "section": heading, "part": i},
                    )
                )
    return chunks
