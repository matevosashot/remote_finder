"""Text access for files of any size: head, tail, from line, from byte offset, grep, and follow."""

from __future__ import annotations

import asyncio
import os
import re
import threading
import time
from typing import Iterator, Literal

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from .fsutil import norm, os_error

router = APIRouter()

BLOCK = 1 << 20           # forward read size
RBLOCK = 64 << 10         # backward read size
MAX_LINE = 64 << 10       # longer lines are cut
MAX_RESPONSE = 5 << 20    # total bytes of text returned
MAX_SCAN_SECONDS = 20     # grep gives up (partial result) after this long
INDEX_STEP = 10_000       # sparse line index granularity


def _decode(b: bytes) -> str:
    if b.endswith(b"\r"):
        b = b[:-1]
    return b.decode("utf-8", errors="replace")


def iter_forward(f, start: int) -> Iterator[tuple[int, bytes, bool, int]]:
    """Yield (offset, line_without_newline, was_cut, next_offset) from byte `start`. Memory bounded per line."""
    f.seek(start)
    pos = start
    buf = bytearray()
    line_start = start
    cut = False
    while True:
        chunk = f.read(BLOCK)
        if not chunk:
            break
        i = 0
        while True:
            j = chunk.find(b"\n", i)
            if j < 0:
                room = MAX_LINE - len(buf)
                if room > 0:
                    buf += chunk[i:i + room]
                if len(chunk) - i > max(room, 0):
                    cut = True
                break
            room = MAX_LINE - len(buf)
            piece = chunk[i:j]
            if len(piece) > room:
                piece, cut = piece[:max(room, 0)], True
            buf += piece
            yield line_start, bytes(buf), cut, pos + j + 1
            line_start = pos + j + 1
            buf.clear()
            cut = False
            i = j + 1
        pos += len(chunk)
    if buf or cut:
        yield line_start, bytes(buf), cut, pos


def iter_backward(f, end: int) -> Iterator[tuple[int, bytes, bool, int]]:
    """Yield (offset, line, was_cut, next_offset) walking backwards from byte `end` (exclusive)."""
    if end <= 0:
        return
    size = end
    f.seek(end - 1)
    if f.read(1) == b"\n":
        end -= 1  # a final newline terminates the last line rather than starting an empty one
    pos = end
    carry, carry_cut = b"", False  # leftmost bytes of the line whose start is not read yet
    line_end = end                 # file offset just past the current rightmost unfinished line
    while pos > 0:
        n = min(RBLOCK, pos)
        pos -= n
        f.seek(pos)
        data = f.read(n) + carry  # data[i] is file offset pos + i
        right, cut_right = len(data), carry_cut
        j = data.rfind(b"\n", 0, right)
        while j >= 0:
            line, cut = data[j + 1:right], cut_right
            if len(line) > MAX_LINE:
                line, cut = line[:MAX_LINE], True
            yield pos + j + 1, line, cut, min(line_end + 1, size)
            line_end = pos + j
            right, cut_right = j, False
            j = data.rfind(b"\n", 0, right)
        carry, carry_cut = data[:right], cut_right
        if len(carry) > MAX_LINE:
            carry, carry_cut = carry[:MAX_LINE], True
    yield 0, carry, carry_cut, min(line_end + 1, size)


class LineIndex:
    """Sparse map line-number -> byte offset, built lazily, per file version."""

    _cache: dict[str, "LineIndex"] = {}
    _lock = threading.Lock()

    def __init__(self, key: tuple) -> None:
        self.key = key
        self.offsets = [0]        # offsets[k] = byte offset of line k*STEP + 1
        self.scanned_lines = 0    # complete lines counted so far
        self.scanned_pos = 0      # byte offset up to which newlines were counted
        self.done = False

    @classmethod
    def get(cls, path: str, st: os.stat_result) -> "LineIndex":
        key = (st.st_ino, st.st_size, st.st_mtime_ns)
        with cls._lock:
            idx = cls._cache.get(path)
            if not idx or idx.key != key:
                idx = cls._cache[path] = LineIndex(key)
                if len(cls._cache) > 64:
                    cls._cache.pop(next(iter(cls._cache)))
            return idx

    def ensure(self, f, line: int, size: int) -> None:
        """Scan until the checkpoint for `line` (1-based) is known or EOF."""
        want = (line - 1) // INDEX_STEP
        f.seek(self.scanned_pos)
        while len(self.offsets) <= want and not self.done:
            chunk = f.read(BLOCK)
            if not chunk:
                self.done = True
                break
            n = chunk.count(b"\n")
            next_mark = len(self.offsets) * INDEX_STEP  # lines needed before the next checkpoint
            if self.scanned_lines + n >= next_mark:
                i = 0
                lines = self.scanned_lines
                while True:
                    j = chunk.find(b"\n", i)
                    if j < 0:
                        break
                    lines += 1
                    if lines == len(self.offsets) * INDEX_STEP:
                        self.offsets.append(self.scanned_pos + j + 1)
                    i = j + 1
            self.scanned_lines += n
            self.scanned_pos += len(chunk)
            if self.scanned_pos >= size:
                self.done = True

    @property
    def total_lines(self) -> int | None:
        return self.scanned_lines if self.done else None


def _open(path: str):
    try:
        st = os.stat(path)
        if not os.path.isfile(path):
            raise HTTPException(400, "not a regular file")
        return open(path, "rb"), st
    except OSError as e:
        raise os_error(e)


def _looks_binary(f) -> bool:
    f.seek(0)
    return b"\x00" in f.read(8192)


def _next_line_start(f, offset: int) -> int:
    """The first line start at or after `offset` (reads in blocks, so giant lines stay cheap)."""
    if offset <= 0:
        return 0
    f.seek(offset - 1)
    if f.read(1) == b"\n":
        return offset
    while chunk := f.read(BLOCK):
        j = chunk.find(b"\n")
        if j >= 0:
            return offset + j + 1
        offset += len(chunk)
    return offset


def _collect(lines: Iterator[tuple[int, bytes, bool, int]], n: int, rx: re.Pattern | None, invert: bool,
             first_line: int | None, skip: int) -> tuple[list[dict], int | None, int | None, bool]:
    """Take up to `n` (matching) lines. Returns (items, next_offset, grep_stopped_at, truncated)."""
    out: list[dict] = []
    budget = MAX_RESPONSE
    deadline = time.monotonic() + MAX_SCAN_SECONDS
    lineno = first_line or 0
    nxt = stopped_at = None
    for off, raw, cut, nxt_off in lines:
        if skip > 0:
            skip -= 1
            lineno += 1
            continue
        if rx is None or bool(rx.search(raw)) != invert:
            item = {"o": off, "t": _decode(raw)}
            if first_line is not None:
                item["n"] = lineno
            if cut:
                item["cut"] = True
            out.append(item)
            nxt = nxt_off
            budget -= len(raw)
            if len(out) >= n or budget <= 0:
                break
        lineno += 1
        if rx is not None and time.monotonic() > deadline:
            stopped_at = off
            break
    return out, nxt, stopped_at, budget <= 0


@router.get("/api/text")
def read_text(
    path: str = Query(...),
    mode: Literal["head", "tail", "line", "byte"] = "tail",
    n: int = Query(200, ge=1, le=1_000_000),
    start: int = Query(1, ge=0),
    grep: str | None = None,
    icase: bool = False,
    invert: bool = False,
) -> dict:
    """Return up to `n` lines. With `grep`, return up to `n` matching lines (with line numbers when known)."""
    path = norm(path)
    rx = None
    if grep:
        try:
            rx = re.compile(grep.encode(), re.IGNORECASE if icase else 0)
        except re.error as e:
            raise HTTPException(400, f"bad regex: {e}")
    f, st = _open(path)
    with f:
        size = st.st_size
        binary = _looks_binary(f)
        first_line = total_lines = None  # line numbers are only known when reading from a known line
        skip = 0
        if mode == "tail":
            lines = iter_backward(f, size)
        else:
            if mode == "head":
                offset, first_line = 0, 1
            elif mode == "line":
                want = start or 1
                idx = LineIndex.get(path, st)
                idx.ensure(f, want, size)
                k = min((want - 1) // INDEX_STEP, len(idx.offsets) - 1)
                offset, first_line = idx.offsets[k], k * INDEX_STEP + 1
                skip = want - first_line  # walk from the checkpoint to the wanted line
                total_lines = idx.total_lines
            else:  # byte offset: align to the next line start
                offset = _next_line_start(f, min(start, size))
            lines = iter_forward(f, offset)
        out, nxt, stopped_at, truncated = _collect(lines, n, rx, invert, first_line, skip)
    if mode == "tail":
        out.reverse()
    return {
        "path": path, "size": size, "mtime_ns": str(st.st_mtime_ns), "mtime": st.st_mtime, "ino": st.st_ino,
        "binary": binary, "mode": mode, "lines": out, "first_line": out[0].get("n") if out else None,
        "end": size, "next": nxt if mode != "tail" else None, "total_lines": total_lines,
        "stopped_at": stopped_at, "truncated": truncated,
    }


@router.websocket("/ws/follow")
async def follow(ws: WebSocket, path: str, pos: int = -1) -> None:
    """tail -f: push complete new lines; announce truncation/rotation with a reset."""
    await ws.accept()
    try:
        path = norm(path)
        st = await asyncio.to_thread(os.stat, path)
    except Exception as e:
        await ws.send_json({"type": "error", "error": str(getattr(e, "detail", e))})
        await ws.close()
        return
    ino = st.st_ino
    pos = st.st_size if pos < 0 or pos > st.st_size else pos
    partial = b""

    def read_new(start: int, size: int) -> bytes:
        with open(path, "rb") as fh:
            fh.seek(start)
            return fh.read(min(size - start, 4 << 20))

    async def pump() -> None:
        nonlocal ino, pos, partial
        while True:
            try:
                st = await asyncio.to_thread(os.stat, path)
            except FileNotFoundError:
                await asyncio.sleep(0.5)
                continue
            if st.st_ino != ino or st.st_size < pos:
                reason = "rotated" if st.st_ino != ino else "truncated"
                ino, pos, partial = st.st_ino, 0, b""
                await ws.send_json({"type": "reset", "reason": reason})
            if st.st_size > pos:
                data = await asyncio.to_thread(read_new, pos, st.st_size)
                pos += len(data)
                data = partial + data
                cut = data.rfind(b"\n")
                if cut >= 0:
                    complete, partial = data[:cut], data[cut + 1:]
                    lines = [_decode(x)[:MAX_LINE] for x in complete.split(b"\n")]
                    await ws.send_json({"type": "lines", "lines": lines, "end": pos})
                else:
                    partial = data[-MAX_LINE:]
                continue  # more may be pending; read again without sleeping
            await asyncio.sleep(0.5)

    task = asyncio.create_task(pump())
    try:
        while True:
            await ws.receive_text()  # client pings / close
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()
