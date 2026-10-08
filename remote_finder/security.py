"""Request guards for an unauthenticated, localhost-only app that exposes a shell.

- Host must be a loopback name (blocks DNS rebinding).
- WebSockets and state-changing requests must carry an Origin matching Host.
- State-changing requests must carry `X-Remote-Finder: 1`, which forces a CORS
  preflight that this app never approves, so other websites cannot forge them.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from .config import CSRF_HEADER

ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_CSRF = CSRF_HEADER.lower()


def _split_host(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("["):  # [::1]:8090
        return value.split("]")[0] + "]"
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def host_ok(host: str | None) -> bool:
    return bool(host) and _split_host(host) in ALLOWED_HOSTS


def origin_ok(origin: str | None, host: str | None) -> bool:
    if not origin or not host:
        return False
    parts = urlsplit(origin)
    return parts.scheme in ("http", "https") and parts.netloc.lower() == host.strip().lower()


class GuardMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        host = headers.get("host")
        origin = headers.get("origin")

        if not host_ok(host):
            return await self._deny(scope, receive, send, 400, "bad host")

        if scope["type"] == "websocket":
            if not origin_ok(origin, host):
                return await self._deny(scope, receive, send, 403, "bad origin")
        elif scope["method"] not in SAFE_METHODS:
            if headers.get(_CSRF) != "1":
                return await self._deny(scope, receive, send, 403, f"missing {CSRF_HEADER} header")
            if origin is not None and not origin_ok(origin, host):
                return await self._deny(scope, receive, send, 403, "bad origin")

        await self.app(scope, receive, send)

    @staticmethod
    async def _deny(scope: Scope, receive: Receive, send: Send, status: int, msg: str) -> None:
        if scope["type"] == "websocket":
            await receive()  # websocket.connect
            await send({"type": "websocket.close", "code": 1008, "reason": msg})
            return
        body = msg.encode()
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"text/plain"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})


# Types that can run script when rendered from our origin; served as text unless sandboxed render.
ACTIVE_TYPES = {"text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"}


def raw_headers(media_type: str, render: bool) -> tuple[str, dict[str, str]]:
    """Return (media_type, extra headers) for serving user files from our origin."""
    headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"}
    base = media_type.split(";")[0].strip()
    if base == "application/pdf":
        return media_type, headers  # Chrome's PDF viewer refuses to load in a sandboxed document
    if base in ACTIVE_TYPES and render:
        headers["Content-Security-Policy"] = "sandbox allow-scripts"
    else:
        if base in ACTIVE_TYPES:
            media_type = "text/plain"
        headers["Content-Security-Policy"] = "sandbox"
    if media_type.startswith("text/") and "charset" not in media_type:
        media_type += "; charset=utf-8"
    return media_type, headers
