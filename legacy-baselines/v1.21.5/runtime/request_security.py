"""Small request trust-boundary checks for the loopback Tavern HTTP server."""

from __future__ import annotations

import os
import re
from urllib.parse import urlsplit


_HEADER_NAME = re.compile(r"^[A-Za-z0-9-]{1,80}$")


def _first_header_value(value):
    return str(value or "").split(",", 1)[0].strip()


def _normalized_origin(value):
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    if parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


class RequestAuthorizer:
    """Validate browser origins and an optional identity asserted by the relay."""

    def __init__(self, *, allowed_origins=None, trusted_user_header=None):
        raw_origins = (
            os.environ.get("TAVERN_ALLOWED_ORIGINS", "")
            if allowed_origins is None else allowed_origins
        )
        self.allowed_origins = frozenset(
            origin for origin in (
                _normalized_origin(item) for item in str(raw_origins or "").split(",")
            ) if origin
        )
        header = (
            os.environ.get("TAVERN_TRUSTED_USER_HEADER", "")
            if trusted_user_header is None else trusted_user_header
        )
        header = str(header or "").strip()
        if header and not _HEADER_NAME.fullmatch(header):
            raise ValueError("TAVERN_TRUSTED_USER_HEADER is invalid")
        self.trusted_user_header = header

    @staticmethod
    def _request_origins(headers):
        forwarded_proto = _first_header_value(headers.get("X-Forwarded-Proto")).lower()
        if forwarded_proto not in {"http", "https"}:
            forwarded_proto = ""
        candidates = set()
        for name in ("X-Forwarded-Host", "X-Original-Host"):
            host = _first_header_value(headers.get(name)).lower()
            if host:
                candidates.add(f"{forwarded_proto or 'https'}://{host}")
        host = _first_header_value(headers.get("Host")).lower()
        if host:
            candidates.add(f"{forwarded_proto or 'http'}://{host}")
        return candidates

    def rejection_reason(self, headers, *, state_changing=False):
        if self.trusted_user_header and not str(headers.get(self.trusted_user_header) or "").strip():
            return "trusted relay identity is required"
        if not state_changing:
            return ""
        raw_origin = str(headers.get("Origin") or "").strip()
        if not raw_origin:
            # Non-browser clients and the local agent do not necessarily send Origin.
            return ""
        origin = _normalized_origin(raw_origin)
        allowed = set(self.allowed_origins)
        allowed.update(self._request_origins(headers))
        if not origin or origin not in allowed:
            return "request origin is not allowed"
        return ""
