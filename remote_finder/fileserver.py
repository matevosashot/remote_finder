"""File servers started from the UI: `python -m http.server` with Range requests, a request log,
and automatic stops when unused for a while or when the Finder tab that started them closes."""

from __future__ import annotations

import asyncio
import collections
import getpass
import itertools
import json
import os
import re
import socket
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Literal
from urllib.parse import quote

import psutil
from fastapi import APIRouter, HTTPException, WebSocket
from pydantic import BaseModel, Field

from .fsutil import norm

router = APIRouter()

GRACE = 15.0  # seconds a closed tab has to come back (a reload keeps its id) before its servers stop
TICK = 5.0  # reaper period
LOG_LINES = 500
PORT_TRIES = 20
SKIP_IFACES = ("lo", "docker", "veth", "br-", "virbr")

_lock = threading.RLock()
_servers: dict[str, FileServer] = {}
_finished: collections.OrderedDict[str, FileServer] = collections.OrderedDict()  # recent, for their logs
_tabs: dict[str, dict] = {}  # tab id -> {"conns": open WebSockets, "gone_at": time the last one closed}
_events: list[dict] = []  # servers that stopped, for the tabs' toasts: {n, id, port, reason}
_version = 0  # bumped on every change; WebSockets push the list when it moves
_ids = itertools.count(1)
_reaper: threading.Thread | None = None


def _changed() -> None:
    global _version
    _version += 1


class _HTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    fs: FileServer


class Handler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler plus single-range requests, no-cache, optional CORS, and logging into the server."""
    server: _HTTPServer
    _remaining: int | None = None

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        if self.server.fs.cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def send_head(self):
        self._remaining = None
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", (rng or "").strip())
        if not m or not (m[1] or m[2]) or self.path.split("?")[0].endswith("/") or not os.path.isfile(path):
            return super().send_head()  # no (single) range: plain http.server behaviour
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        st = os.fstat(f.fileno())
        size = st.st_size
        if m[1]:
            start, end = int(m[1]), min(int(m[2]) if m[2] else size - 1, size - 1)
        else:
            start, end = max(0, size - int(m[2])), size - 1
        if start > end:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", self.date_time_string(st.st_mtime))
        self.end_headers()
        f.seek(start)
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile) -> None:
        left = self._remaining
        fs = self.server.fs
        while left is None or left > 0:
            chunk = source.read(65536 if left is None else min(left, 65536))
            if not chunk:
                break
            outputfile.write(chunk)
            if left is not None:
                left -= len(chunk)
            fs.sent(len(chunk))  # a long download counts as use

    def log_request(self, code="-", size="-") -> None:
        self.server.fs.record(self.client_address[0], self.requestline, int(getattr(code, "value", code)))

    def log_error(self, format, *args) -> None:
        if not format.startswith("code %d"):  # send_error logs the request line anyway
            self.server.fs.record(self.client_address[0], format % args, None)

    def log_message(self, format, *args) -> None:
        self.server.fs.record(self.client_address[0], format % args, None)


class FileServer:
    def __init__(self, root: str, host: str, port: int, idle_limit: float | None, tab: str | None,
                 stop_with_tab: bool, cors: bool, open_path: str | None) -> None:
        self.id = str(next(_ids))
        self.root, self.host, self.idle_limit = root, host, idle_limit
        self.owner_tab, self.stop_with_tab, self.cors, self.open = tab, stop_with_tab, cors, open_path
        self.started = self.last_used = time.time()
        self.requests = self.bytes = self.seq = 0
        self.log: collections.deque[dict] = collections.deque(maxlen=LOG_LINES)
        self.reason: str | None = None  # why it stopped
        self.httpd = _HTTPServer((host, port), partial(Handler, directory=root))
        self.httpd.fs = self
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.25},
                                       name=f"fileserver-{self.port}", daemon=True)

    def record(self, client: str, line: str, status: int | None) -> None:
        with _lock:
            self.seq += 1
            self.log.append({"n": self.seq, "t": time.time(), "client": client, "line": line, "status": status})
            if status is not None:
                self.requests += 1
            self.last_used = time.time()
            _changed()

    def sent(self, n: int) -> None:
        self.bytes += n
        self.last_used = time.time()

    def urls(self) -> list[dict]:
        tail = quote(self.open or "")
        out = [{"label": "This machine", "url": f"http://localhost:{self.port}/{tail}"}]
        if self.host == "0.0.0.0":
            out.append({"label": "Host name", "url": f"http://{socket.gethostname()}:{self.port}/{tail}"})
            for name, addrs in sorted(psutil.net_if_addrs().items()):
                if name.startswith(SKIP_IFACES):
                    continue
                for a in addrs:
                    if a.family == socket.AF_INET and not a.address.startswith("127."):
                        out.append({"label": name, "url": f"http://{a.address}:{self.port}/{tail}"})
        return out

    def public(self, now: float | None = None) -> dict:
        now = now or time.time()
        return {
            "id": self.id, "root": self.root, "name": os.path.basename(self.root) or "/", "host": self.host,
            "port": self.port, "open": self.open, "cors": self.cors, "owner_tab": self.owner_tab,
            "stop_with_tab": self.stop_with_tab, "idle_limit": self.idle_limit,
            "idle_left": None if self.idle_limit is None else max(0, self.idle_limit - (now - self.last_used)),
            "started": self.started, "last_used": self.last_used, "requests": self.requests, "bytes": self.bytes,
            "running": self.reason is None, "reason": self.reason,
            "urls": self.urls(),
            "tunnel": f"ssh -N -L {self.port}:localhost:{self.port} {getpass.getuser()}@{socket.gethostname()}",
        }


def stop(fs: FileServer, reason: str) -> None:
    with _lock:
        if _servers.pop(fs.id, None) is None:
            return
        fs.reason = reason
        _finished[fs.id] = fs
        while len(_finished) > 10:
            _finished.popitem(last=False)
        _events.append({"n": len(_events) + 1, "id": fs.id, "port": fs.port, "name": os.path.basename(fs.root), "reason": reason})
        _changed()
    fs.httpd.shutdown()
    fs.httpd.server_close()


def reap(now: float | None = None) -> None:
    """Stop servers unused for longer than their limit, or whose tab has been gone longer than GRACE."""
    now = now or time.time()
    with _lock:
        servers = list(_servers.values())
    for fs in servers:
        if fs.idle_limit is not None and now - fs.last_used > fs.idle_limit:
            stop(fs, f"unused for {fs.idle_limit / 60:g} min")
        elif fs.stop_with_tab and fs.owner_tab:
            tab = _tabs.get(fs.owner_tab)
            gone_at = fs.started if tab is None else tab["gone_at"]
            if gone_at is not None and now - gone_at > GRACE:
                stop(fs, "its Finder tab closed")


def _reap_forever() -> None:
    while True:
        time.sleep(TICK)
        try:
            reap()
        except Exception:  # keep reaping whatever one server did
            pass


def start(root: str, port: int, host: str, idle_limit: float | None, tab: str | None, stop_with_tab: bool,
          cors: bool, open_path: str | None = None) -> tuple[FileServer, str | None]:
    """Start a server on `port` or, if that is busy, one of the next PORT_TRIES ports. Returns (server, note)."""
    global _reaper
    last: OSError | None = None
    for p in range(port, min(port + PORT_TRIES, 65536)):
        try:
            fs = FileServer(root, host, p, idle_limit, tab, stop_with_tab, cors, open_path)
            break
        except PermissionError as e:
            raise HTTPException(400, f"Port {p} needs root; pick one above 1023") from e
        except OSError as e:
            last = e
    else:
        raise HTTPException(409, f"Ports {port}-{port + PORT_TRIES - 1} are all in use ({last})")
    fs.thread.start()  # before anyone can stop it: shutdown() waits for serve_forever to have run
    with _lock:
        _servers[fs.id] = fs
        _changed()
        if _reaper is None:
            _reaper = threading.Thread(target=_reap_forever, name="fileserver-reaper", daemon=True)
            _reaper.start()
    return fs, (f"Port {port} is in use, so it runs on {fs.port}" if fs.port != port else None)


def find(sid: str) -> FileServer:
    fs = _servers.get(sid) or _finished.get(sid)
    if fs is None:
        raise HTTPException(404, "no such file server")
    return fs


# ---------------------------------------------------------------- routes


class StartBody(BaseModel):
    path: str
    port: int = Field(8000, ge=1, le=65535)
    host: Literal["0.0.0.0", "127.0.0.1"] = "0.0.0.0"
    idle_min: float | None = Field(10, gt=0)  # None: never
    stop_with_tab: bool = True
    cors: bool = False
    tab: str | None = None
    open: str | None = None  # a file inside `path` the URLs should point at


@router.post("/api/fileservers")
def create(body: StartBody) -> dict:
    root = norm(body.path)
    if not os.path.isdir(root):
        raise HTTPException(400, "not a folder")
    fs, note = start(root, body.port, body.host, body.idle_min * 60 if body.idle_min else None,
                     body.tab, body.stop_with_tab, body.cors, body.open)
    return {**fs.public(), "note": note}


@router.get("/api/fileservers")
def list_servers() -> list[dict]:
    now = time.time()
    with _lock:
        return [fs.public(now) for fs in _servers.values()]


@router.get("/api/fileservers/{sid}/log")
def log(sid: str, after: int = 0) -> dict:
    fs = find(sid)
    with _lock:
        lines = [x for x in fs.log if x["n"] > after]
    return {"lines": lines, "server": fs.public()}


@router.post("/api/fileservers/{sid}/stop")
def stop_route(sid: str) -> dict:
    fs = _servers.get(sid)
    if fs is None:
        raise HTTPException(404, "not running")
    stop(fs, "stopped")
    return {"ok": True}


@router.websocket("/ws/fileservers")
async def presence(ws: WebSocket, tab: str) -> None:
    """While a Finder tab is open it holds this socket; its servers stop GRACE seconds after it closes.
    The socket carries the server list (at most once a second) and stop notices."""
    await ws.accept()
    with _lock:
        t = _tabs.setdefault(tab, {"conns": 0, "gone_at": None})
        t["conns"] += 1
        t["gone_at"] = None
    seen_version, seen_event = -1, len(_events)
    recv = asyncio.ensure_future(ws.receive())
    try:
        while True:
            msg: dict = {}
            if _version != seen_version:
                seen_version = _version
                msg["servers"] = list_servers()
            if len(_events) > seen_event:
                msg["stopped"] = _events[seen_event:]
                seen_event = len(_events)
            if msg:
                await ws.send_text(json.dumps(msg))
            done, _ = await asyncio.wait({recv}, timeout=1)
            if done:
                if recv.result()["type"] == "websocket.disconnect":
                    break
                recv = asyncio.ensure_future(ws.receive())
    except Exception:  # the tab went away mid-send
        pass
    finally:
        recv.cancel()
        with _lock:
            t["conns"] -= 1
            if t["conns"] <= 0:
                t["gone_at"] = time.time()
