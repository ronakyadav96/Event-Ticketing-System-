"""
Per-minute chat quotas, so one browser (or a script rotating guest ids) cannot burn the
Gemini quota for everyone. Fixed one-minute windows: Redis counters when Redis is connected
(shared by all workers), otherwise an in-process dict (single worker, development).
"""

import logging
import time
from typing import Dict, Tuple

from db.redis_client import turn_lock

logger = logging.getLogger(__name__)

WINDOW_SECONDS = 60


class RateLimited(Exception):
    """The caller exceeded its chat quota for the current window."""

    def __init__(self, retry_after: int):
        super().__init__(f"retry after {retry_after}s")
        self.retry_after = retry_after


class RateLimiter:
    def __init__(self):
        self._local: Dict[str, Tuple[int, int]] = {}  # key -> (window, count)

    def reset(self) -> None:
        self._local.clear()

    async def _hit(self, key: str, window: int) -> int:
        redis = turn_lock._redis
        if redis is not None:
            try:
                redis_key = f"ratelimit:{key}:{window}"
                count = await redis.incr(redis_key)
                if count == 1:
                    await redis.expire(redis_key, WINDOW_SECONDS * 2)
                return int(count)
            except Exception as exc:  # never block chat because Redis hiccuped
                logger.warning("Rate limit counter unavailable (%s); using in-process counter.", exc)

        if len(self._local) > 10_000:  # drop finished windows
            self._local = {k: v for k, v in self._local.items() if v[0] == window}
        prev_window, count = self._local.get(key, (window, 0))
        count = count + 1 if prev_window == window else 1
        self._local[key] = (window, count)
        return count

    async def check(self, limits: Dict[str, int]) -> None:
        """`limits` maps a counter key to its per-minute maximum; raises RateLimited if any is exceeded."""
        now = time.time()
        window = int(now // WINDOW_SECONDS)
        for key, maximum in limits.items():
            if maximum > 0 and await self._hit(key, window) > maximum:
                raise RateLimited(retry_after=max(1, int((window + 1) * WINDOW_SECONDS - now)))


rate_limiter = RateLimiter()
