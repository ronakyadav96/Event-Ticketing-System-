"""
Request identity.

- Authenticated: `Authorization: Bearer <JWT>` issued by the Node backend, verified here with
  the shared HS256 secret (and verified again by Node on every forwarded call).
- Guest: no token. The browser sends a random `X-Guest-Id`; guests are namespaced as
  "guest:<id>" and can only search, read FAQs and chat — never book, pay or refund.

User IDs, booking state, prices or payment status sent in request bodies are never trusted.
"""

import base64
import hashlib
import hmac
import json
import re
import time
from typing import Any, Dict, Optional

from fastapi import Header, HTTPException, status
from pydantic import BaseModel

from config import settings

_GUEST_ID = re.compile(r"^[A-Za-z0-9-]{16,64}$")


class Identity(BaseModel):
    user_id: str
    is_authenticated: bool
    role: str = "guest"
    token: Optional[str] = None


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def _b64url_decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def verify_jwt(token: str) -> Dict[str, Any]:
    secret = (settings.JWT_SECRET or "").strip()
    if not secret:
        raise _unauthorized("Authentication is not configured on the AI service.")
    parts = token.split(".")
    if len(parts) != 3:
        raise _unauthorized("Malformed token.")
    header_b64, payload_b64, sig_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
        signature = _b64url_decode(sig_b64)
    except (ValueError, json.JSONDecodeError):
        raise _unauthorized("Malformed token.")
    if header.get("alg") != "HS256":
        raise _unauthorized("Unsupported token algorithm.")
    expected = hmac.new(secret.encode(), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise _unauthorized("Invalid token.")
    exp = payload.get("exp")
    if exp is not None and float(exp) < time.time():
        raise _unauthorized("Token expired.")
    return payload


async def get_identity(
    authorization: Optional[str] = Header(default=None),
    x_guest_id: Optional[str] = Header(default=None),
) -> Identity:
    if authorization:
        match = re.match(r"^\s*Bearer\s+(\S+)\s*$", authorization, re.IGNORECASE)
        if not match:
            raise _unauthorized("Expected a Bearer token.")
        token = match.group(1).strip("\"'")
        payload = verify_jwt(token)
        uid = str(payload.get("id") or payload.get("_id") or payload.get("userId") or payload.get("sub") or "").strip()
        if not uid:
            raise _unauthorized("Token has no user id.")
        return Identity(user_id=uid, is_authenticated=True, role=str(payload.get("role") or "user"), token=token)

    if not x_guest_id or not _GUEST_ID.match(x_guest_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing or invalid X-Guest-Id header for guest access.")
    return Identity(user_id=f"guest:{x_guest_id}", is_authenticated=False)
