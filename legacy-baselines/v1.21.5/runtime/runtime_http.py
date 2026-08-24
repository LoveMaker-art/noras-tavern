"""HTTP resource limits for the stdlib Tavern server."""

from __future__ import annotations

import os
import ipaddress
import socket
import threading
from http.server import ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


class RequestBodyTooLarge(ValueError):
    pass


def safe_static_path(root: str, request_path: str) -> str:
    """Resolve a URL path below the static root or reject traversal."""
    root = os.path.realpath(root)
    relative = unquote(request_path).lstrip("/") or "index.html"
    candidate = os.path.realpath(os.path.join(root, relative))
    if os.path.commonpath((root, candidate)) != root:
        raise ValueError("static path escapes reader root")
    return candidate


def validate_outbound_http_base(value: str) -> str:
    """Reject model endpoints that resolve to local or special-purpose networks."""
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("model base must be an http(s) URL")
    if parsed.username or parsed.password:
        raise ValueError("model base must not contain credentials")
    if os.environ.get("TAVERN_ALLOW_PRIVATE_MODEL_BASES") == "1":
        return value
    try:
        addresses = socket.getaddrinfo(
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as error:
        raise ValueError(f"model base host cannot be resolved: {error}") from error
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("model base must not resolve to a private or local address")
    return value


def read_request_body(handler, limit: int) -> bytes:
    """Read fixed or chunked HTTP bodies without exceeding ``limit`` bytes."""
    content_length = handler.headers.get("Content-Length")
    transfer_encoding = (handler.headers.get("Transfer-Encoding") or "").strip().lower()
    if content_length is not None and transfer_encoding:
        raise ValueError("Content-Length and Transfer-Encoding cannot be combined")
    if content_length is not None:
        try:
            length = int(content_length)
        except (TypeError, ValueError) as error:
            raise ValueError("invalid Content-Length") from error
        if length < 0:
            raise ValueError("invalid Content-Length")
        if length > limit:
            raise RequestBodyTooLarge(f"request body exceeds {limit} bytes")
        return handler.rfile.read(length)

    if not transfer_encoding:
        return b""
    encodings = [item.strip() for item in transfer_encoding.split(",") if item.strip()]
    if encodings != ["chunked"]:
        raise ValueError("unsupported Transfer-Encoding")

    chunks = []
    total = 0
    while True:
        size_line = handler.rfile.readline(128).strip()
        if not size_line:
            raise ValueError("incomplete chunked body")
        try:
            size = int(size_line.split(b";", 1)[0], 16)
        except ValueError as error:
            raise ValueError("invalid chunk size") from error
        if size == 0:
            trailer_bytes = 0
            while True:
                trailer = handler.rfile.readline(1024)
                if not trailer:
                    raise ValueError("incomplete chunk trailer")
                trailer_bytes += len(trailer)
                if trailer_bytes > 8192:
                    raise ValueError("chunk trailers are too large")
                if trailer == b"\r\n":
                    break
                if not trailer.endswith(b"\r\n") or b":" not in trailer:
                    raise ValueError("invalid chunk trailer")
            break
        total += size
        if total > limit:
            raise RequestBodyTooLarge(f"request body exceeds {limit} bytes")
        chunk = handler.rfile.read(size)
        if len(chunk) != size:
            raise ValueError("incomplete chunk")
        chunks.append(chunk)
        if handler.rfile.readline(2) != b"\r\n":
            raise ValueError("invalid chunk terminator")
    return b"".join(chunks)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with bounded active request threads.

    Acquiring before starting a worker applies backpressure at the accept loop and
    avoids another queue or resident service.  The default is conservative for a
    four-core Tavern host whose requests may block on model providers.
    """

    daemon_threads = True

    def __init__(self, server_address, request_handler_class, max_workers=None):
        configured = max_workers if max_workers is not None else os.environ.get("TAVERN_MAX_HTTP_WORKERS", "8")
        self.max_workers = min(64, max(2, int(configured)))
        self._request_slots = threading.BoundedSemaphore(self.max_workers)
        super().__init__(server_address, request_handler_class)

    def process_request(self, request, client_address):
        self._request_slots.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()
