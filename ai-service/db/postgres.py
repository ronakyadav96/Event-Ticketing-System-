"""
Conversation & message persistence (PostgreSQL via psycopg async pool).

An in-memory store is used only as an explicit development fallback
(settings.allow_memory_fallback); in production a database failure is surfaced.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from config import settings

logger = logging.getLogger(__name__)

DDL = [
    """
    CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64),
        title VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGSERIAL PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
        role VARCHAR(32) NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC)",
]


class StoreUnavailable(Exception):
    """Conversation storage is not reachable."""


def psycopg_conninfo() -> Optional[str]:
    url = (settings.POSTGRES_URL or "").strip()
    if not url:
        return None
    for prefix in ("postgresql+psycopg://", "postgresql+asyncpg://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql://" + url[len(prefix):]
    return url


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if hasattr(value, "isoformat") else (str(value) if value else None)


class PostgresConversationStore:
    def __init__(self, conninfo: str):
        self.conninfo = conninfo
        self.pool = None

    async def open(self) -> None:
        from psycopg_pool import AsyncConnectionPool

        self.pool = AsyncConnectionPool(self.conninfo, max_size=10, kwargs={"autocommit": True}, open=False)
        await self.pool.open(wait=True, timeout=5)
        async with self.pool.connection() as conn:
            for stmt in DDL:
                await conn.execute(stmt)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()

    async def _fetch(self, sql: str, params: tuple = ()) -> List[tuple]:
        try:
            async with self.pool.connection() as conn:
                cur = await conn.execute(sql, params)
                return await cur.fetchall() if cur.description else []
        except Exception as exc:
            logger.error("PostgreSQL error: %s", exc)
            raise StoreUnavailable(str(exc)) from exc

    async def get_owner(self, conversation_id: str) -> Optional[str]:
        rows = await self._fetch("SELECT user_id FROM chat_sessions WHERE session_id = %s", (conversation_id,))
        return rows[0][0] if rows else None

    async def create(self, conversation_id: str, user_id: str, title: str) -> None:
        await self._fetch(
            "INSERT INTO chat_sessions (session_id, user_id, title) VALUES (%s, %s, %s) ON CONFLICT (session_id) DO NOTHING",
            (conversation_id, user_id, title),
        )

    async def touch(self, conversation_id: str, title_hint: str) -> None:
        await self._fetch(
            "UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP, "
            "title = CASE WHEN title = 'New Chat' THEN %s ELSE title END WHERE session_id = %s",
            (title_hint, conversation_id),
        )

    async def add_message(self, conversation_id: str, role: str, content: str, metadata: Dict[str, Any]) -> None:
        await self._fetch(
            "INSERT INTO chat_messages (session_id, role, content, metadata) VALUES (%s, %s, %s, %s::jsonb)",
            (conversation_id, role, content, json.dumps(metadata, default=str)),
        )

    async def list_conversations(self, user_id: str) -> List[Dict[str, Any]]:
        rows = await self._fetch(
            "SELECT session_id, title, created_at, updated_at FROM chat_sessions WHERE user_id = %s "
            "ORDER BY updated_at DESC LIMIT 50",
            (user_id,),
        )
        return [{"id": r[0], "title": r[1], "created_at": _iso(r[2]), "updated_at": _iso(r[3])} for r in rows]

    async def list_messages(self, conversation_id: str) -> List[Dict[str, Any]]:
        rows = await self._fetch(
            "SELECT id, role, content, metadata, created_at FROM chat_messages WHERE session_id = %s ORDER BY id",
            (conversation_id,),
        )
        return [
            {"id": r[0], "role": r[1], "content": r[2], "metadata": r[3] or {}, "timestamp": _iso(r[4])} for r in rows
        ]

    async def clear_messages(self, conversation_id: str) -> None:
        await self._fetch("DELETE FROM chat_messages WHERE session_id = %s", (conversation_id,))

    async def delete(self, conversation_id: str) -> None:
        await self._fetch("DELETE FROM chat_sessions WHERE session_id = %s", (conversation_id,))


class MemoryConversationStore:
    """Development-only fallback. Data is lost on restart."""

    def __init__(self):
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.messages: Dict[str, List[Dict[str, Any]]] = {}

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def get_owner(self, conversation_id: str) -> Optional[str]:
        session = self.sessions.get(conversation_id)
        return session["user_id"] if session else None

    async def create(self, conversation_id: str, user_id: str, title: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self.sessions.setdefault(conversation_id, {"id": conversation_id, "user_id": user_id, "title": title, "created_at": now, "updated_at": now})

    async def touch(self, conversation_id: str, title_hint: str) -> None:
        session = self.sessions.get(conversation_id)
        if session:
            session["updated_at"] = datetime.now(timezone.utc).isoformat()
            if session["title"] == "New Chat":
                session["title"] = title_hint

    async def add_message(self, conversation_id: str, role: str, content: str, metadata: Dict[str, Any]) -> None:
        msgs = self.messages.setdefault(conversation_id, [])
        msgs.append({"id": len(msgs) + 1, "role": role, "content": content, "metadata": metadata,
                     "timestamp": datetime.now(timezone.utc).isoformat()})

    async def list_conversations(self, user_id: str) -> List[Dict[str, Any]]:
        items = [
            {k: s[k] for k in ("id", "title", "created_at", "updated_at")}
            for s in self.sessions.values()
            if s["user_id"] == user_id
        ]
        return sorted(items, key=lambda s: s["updated_at"], reverse=True)

    async def list_messages(self, conversation_id: str) -> List[Dict[str, Any]]:
        return list(self.messages.get(conversation_id, []))

    async def clear_messages(self, conversation_id: str) -> None:
        self.messages.pop(conversation_id, None)

    async def delete(self, conversation_id: str) -> None:
        self.sessions.pop(conversation_id, None)
        self.messages.pop(conversation_id, None)


_store: Optional[Any] = None


async def init_store() -> Any:
    global _store
    conninfo = psycopg_conninfo()
    if conninfo:
        store = PostgresConversationStore(conninfo)
        try:
            await store.open()
            _store = store
            logger.info("Conversation store: PostgreSQL")
            return _store
        except Exception as exc:
            await store.close()  # stop the pool's background reconnect attempts
            if not settings.allow_memory_fallback:
                raise
            logger.warning("PostgreSQL unavailable (%s); using in-memory conversation store (development only).", exc)
    elif not settings.allow_memory_fallback:
        raise RuntimeError("POSTGRES_URL is required in production")
    _store = MemoryConversationStore()
    return _store


def get_store() -> Any:
    if _store is None:
        raise StoreUnavailable("Conversation store not initialised")
    return _store


async def close_store() -> None:
    global _store
    if _store is not None:
        await _store.close()
    _store = None
