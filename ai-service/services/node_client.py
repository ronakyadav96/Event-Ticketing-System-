"""
HTTP client for the Node.js/Express backend — the single source of truth for events,
schedules, seat availability, payments, bookings and refunds.

Rules:
- No mock data and no silent fallbacks. Failures raise NodeUnavailable / NodeAPIError and
  the calling agent turns them into a controlled, honest response.
- The end user's own JWT is forwarded for every user-scoped call; the AI service never
  mints tokens, so Node enforces ownership exactly as it does for the web app.
"""

import logging
from typing import Any, Dict, List, Optional

import httpx

from config import settings

logger = logging.getLogger(__name__)


class NodeUnavailable(Exception):
    """Backend unreachable, timed out, or failed unexpectedly."""


class NodeAPIError(Exception):
    """Backend answered with a deliberate 4xx/503 error."""

    def __init__(self, status_code: int, payload: Dict[str, Any]):
        self.status_code = status_code
        self.payload = payload or {}
        self.code = str(self.payload.get("status") or self.payload.get("code") or "")
        self.message = str(self.payload.get("message") or f"Backend error {status_code}")
        super().__init__(f"{status_code} {self.code}: {self.message}")


class NodeBackendClient:
    def __init__(self, base_url: Optional[str] = None, timeout: Optional[float] = None):
        self.base_url = (base_url or settings.NODE_BACKEND_BASE_URL).rstrip("/")
        self.timeout = timeout or settings.NODE_TIMEOUT_SECONDS
        self._client: Optional[httpx.AsyncClient] = None

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                headers={"Accept": "application/json"},
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def _request(
        self,
        method: str,
        path: str,
        *,
        token: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        clean_params = {k: v for k, v in (params or {}).items() if v not in (None, "", [])}
        try:
            client = await self._http()
            resp = await client.request(method, path, params=clean_params, json=json, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            logger.warning("Node backend %s %s unreachable: %s", method, path, exc)
            raise NodeUnavailable(str(exc)) from exc

        try:
            body = resp.json() if resp.content else {}
        except ValueError:
            body = {"message": resp.text[:200]}

        if resp.status_code < 400:
            return body
        if resp.status_code in (400, 401, 403, 404, 409, 422) or (
            resp.status_code in (502, 503) and isinstance(body, dict) and body.get("status")
        ):
            raise NodeAPIError(resp.status_code, body if isinstance(body, dict) else {"message": str(body)})
        logger.error("Node backend %s %s failed with %s: %s", method, path, resp.status_code, str(body)[:200])
        raise NodeUnavailable(f"{resp.status_code}")

    # ── Catalog (public) ───────────────────────────────────────────────────────
    async def search_events(
        self,
        *,
        text: Optional[str] = None,
        category: Optional[str] = None,
        genre: Optional[str] = None,
        venue: Optional[str] = None,
        title: Optional[str] = None,
        max_price: Optional[float] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        exclude: Optional[List[str]] = None,
        page: int = 1,
        limit: int = 5,
    ) -> Dict[str, Any]:
        """Relevance-ranked search over the whole event collection: {"data": [...], "total": n}."""
        body = await self._request(
            "GET",
            "/api/events",
            params={
                "q": text,
                "category": category,
                "genre": genre,
                "venue": venue,
                "title": title,
                "maxPrice": max_price,
                "from": date_from,
                "to": date_to,
                "exclude": ",".join(exclude) if exclude else None,
                "sort": "relevance",
                "page": page,
                "limit": limit,
            },
        )
        return {"data": list(body.get("data") or []), "total": int(body.get("total") or 0)}

    async def get_event(self, event_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/api/events/{event_id}")

    async def get_facets(self) -> Dict[str, Any]:
        return await self._request("GET", "/api/events/facets")

    async def get_schedule(self, event_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/api/events/{event_id}/schedule")

    async def get_availability(self, event_id: str, show_at: str) -> Dict[str, Any]:
        return await self._request("GET", f"/api/events/{event_id}/availability", params={"showAt": show_at})

    # ── Payments (user-scoped) ─────────────────────────────────────────────────
    async def create_checkout(self, token: str, *, event_id: str, show_at: str, seats: List[str]) -> Dict[str, Any]:
        return await self._request(
            "POST",
            "/api/payments/checkout",
            token=token,
            json={"eventId": event_id, "showAt": show_at, "seats": seats},
        )

    async def get_order(self, token: str, session_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/api/payments/orders/{session_id}", token=token)

    async def cancel_order(self, token: str, session_id: str) -> Dict[str, Any]:
        return await self._request("POST", f"/api/payments/orders/{session_id}/cancel", token=token)

    # ── Bookings & refunds (user-scoped) ───────────────────────────────────────
    async def list_my_bookings(self, token: str) -> List[Dict[str, Any]]:
        body = await self._request("GET", "/api/bookings/my", token=token)
        return body if isinstance(body, list) else body.get("data", [])

    async def get_booking_by_ticket(self, token: str, ticket_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/api/bookings/ticket/{ticket_id}", token=token)

    async def refund_quote(self, token: str, ticket_id: str) -> Dict[str, Any]:
        return await self._request("GET", "/api/payments/refund-quote", token=token, params={"ticketId": ticket_id})

    async def refund_status(self, token: str, ticket_id: str) -> Dict[str, Any]:
        return await self._request("GET", "/api/payments/refund-status", token=token, params={"ticketId": ticket_id})

    async def request_refund(self, token: str, ticket_id: str) -> Dict[str, Any]:
        return await self._request("POST", "/api/payments/refund", token=token, json={"ticketId": ticket_id})


node_client = NodeBackendClient()
