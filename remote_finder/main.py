"""Remote Finder: a Finder-style web file manager for localhost."""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
from starlette.types import Receive, Scope, Send

from . import archive_api, assets, du_api, fs_api, jobs, ops_api, search, settings, terminal, text_api, thumbs
from .config import APP_NAME
from .security import GuardMiddleware

STATIC = assets.STATIC

api = FastAPI(title=APP_NAME, docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
for module in (fs_api, ops_api, thumbs, text_api, archive_api, du_api, jobs, search, settings, terminal):
    api.include_router(module.router)


def _page(name: str):
    def page() -> HTMLResponse:
        # the main window gets its first API answers inline, saving a round trip on every new tab
        boot = {"home": fs_api.home(), "settings": settings.load()} if name == "index.html" else None
        return HTMLResponse(assets.render_page(name, boot), headers={"cache-control": "no-cache"})
    return page


for _name in assets.PAGES:
    api.get(f"/{_name}", include_in_schema=False)(_page(_name))
api.get("/", include_in_schema=False)(_page("index.html"))


class CachingStatic(StaticFiles):
    """Versioned URLs (`?v=<content hash>`, written into the pages by assets.py) are cached for good;
    anything else is revalidated, so edits show up on reload."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        versioned = b"v=" in scope.get("query_string", b"")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = [h for h in message.get("headers", []) if h[0] != b"cache-control"]
                cache = b"public, max-age=31536000, immutable" if versioned else b"no-cache"
                message["headers"] = headers + [(b"cache-control", cache)]
            await send(message)

        await super().__call__(scope, receive, send_wrapper)


# gzip for the static files only: API responses include file downloads and live streams
api.mount("/", GZipMiddleware(CachingStatic(directory=STATIC, html=True), minimum_size=1024), name="static")
app = GuardMiddleware(api)  # outermost: host/origin/CSRF-header checks for every request
