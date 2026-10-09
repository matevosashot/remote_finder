"""Remote Finder: a Finder-style web file manager for localhost."""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send

from . import archive_api, du_api, fs_api, jobs, ops_api, search, settings, terminal, text_api, thumbs
from .config import APP_NAME
from .security import GuardMiddleware

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")

api = FastAPI(title=APP_NAME, docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
for module in (fs_api, ops_api, thumbs, text_api, archive_api, du_api, jobs, search, settings, terminal):
    api.include_router(module.router)


class NoCacheStatic(StaticFiles):
    """Always revalidate app assets so edits show up on reload (vendor libs may cache)."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        vendor = scope["path"].startswith("/vendor/")

        async def send_wrapper(message):
            if message["type"] == "http.response.start" and not vendor:
                headers = [h for h in message.get("headers", []) if h[0] != b"cache-control"]
                message["headers"] = headers + [(b"cache-control", b"no-cache")]
            await send(message)

        await super().__call__(scope, receive, send_wrapper)


api.mount("/", NoCacheStatic(directory=STATIC, html=True), name="static")
app = GuardMiddleware(api)  # outermost: host/origin/CSRF-header checks for every request
