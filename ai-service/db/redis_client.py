"""
Redis coordination: one in-flight turn per conversation.

Two concurrent requests on the same conversation would both read the same checkpoint and
the later write would silently discard the earlier one (e.g. a seat selection). A short
Redis lock serialises turns per conversation. Without Redis (development only) an
in-process lock is used, which is correct for a single worker.
"""

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator, Dict, Optional

from config import settings

logger = logging.getLogger(__name__)

LOCK_TTL_SECONDS = 60


class ConversationBusy(Exception):
    """Another turn for this conversation is still running."""


_RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end
"""


class TurnLock:
    def __init__(self):
        self._redis = None
        self._local: Dict[str, asyncio.Lock] = {}

    async def connect(self) -> None:
        if not settings.REDIS_URL:
            if not settings.allow_memory_fallback:
                raise RuntimeError("REDIS_URL is required in production")
            logger.warning("REDIS_URL not set; using in-process conversation locks (development only).")
            return
        try:
            import redis.asyncio as aioredis

            client = aioredis.from_url(settings.REDIS_URL, decode_responses=True, socket_connect_timeout=2, socket_timeout=3)
            await client.ping()
            self._redis = client
            logger.info("Conversation locks: Redis")
        except Exception as exc:
            if not settings.allow_memory_fallback:
                raise
            logger.warning("Redis unavailable (%s); using in-process conversation locks (development only).", exc)

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.aclose()
        self._redis = None

    @property
    def backend(self) -> str:
        return "redis" if self._redis is not None else "memory"

    @asynccontextmanager
    async def hold(self, key: str, wait_seconds: float = 20.0) -> AsyncIterator[None]:
        if self._redis is None:
            lock = self._local.setdefault(key, asyncio.Lock())
            try:
                await asyncio.wait_for(lock.acquire(), timeout=wait_seconds)
            except asyncio.TimeoutError as exc:
                raise ConversationBusy(key) from exc
            try:
                yield
            finally:
                lock.release()
            return

        token = uuid.uuid4().hex
        redis_key = f"turnlock:{key}"
        deadline = asyncio.get_running_loop().time() + wait_seconds
        while not await self._redis.set(redis_key, token, nx=True, ex=LOCK_TTL_SECONDS):
            if asyncio.get_running_loop().time() > deadline:
                raise ConversationBusy(key)
            await asyncio.sleep(0.2)
        try:
            yield
        finally:
            try:
                await self._redis.eval(_RELEASE_SCRIPT, 1, redis_key, token)
            except Exception as exc:  # lock expires on its own
                logger.warning("Failed to release turn lock %s: %s", redis_key, exc)


turn_lock = TurnLock()


async def ping() -> Optional[str]:
    """Health helper: None when healthy, else an error string."""
    if turn_lock._redis is None:
        return "not connected (in-process locks)"
    try:
        await turn_lock._redis.ping()
        return None
    except Exception as exc:
        return str(exc)
