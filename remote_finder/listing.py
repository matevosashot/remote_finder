"""Big folders a page at a time: the server sorts, filters and sends the top of a listing.

Sorted by name, only the entries sent are stat'ed (names and folder-ness come from readdir), so the
first page of a huge folder on slow storage arrives quickly. Other sorts stat everything but still
send only the page. Rows stream in batches, so even the whole listing fills in steadily.
The order follows the client's Intl.Collator (numeric, case- and accent-insensitive) closely enough
that the page the client re-sorts is the right page.
"""

from __future__ import annotations

import collections
import json
import os
import re
import stat
import threading
import time
import unicodedata
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from .fsutil import dir_entry, norm, os_error

router = APIRouter(prefix="/api")

BATCH = 500             # entries per streamed line
BATCH_SECONDS = 0.25    # ...or sooner, so a slow folder still fills in steadily
PROVISIONAL_SECONDS = 1.0  # how often a slow sort sends its best first page so far
CACHE_SECONDS = 30      # a folder stat'ed in full is reused this long for "More", re-sorts and filters
CACHE_MIN = 2000        # smaller folders are cheap to read again
CACHE_SIZE = 2

# ICU's order: whitespace and punctuation (in this order), then digits (as numbers), then letters
_PUNCT_ORDER = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"
_PUNCT = str.maketrans({"\t": "\x01", **{c: chr(1 + i) for i, c in enumerate(_PUNCT_ORDER)}})
_DIGITS = re.compile(r"\d+")
_NUM = "\x28"  # above the punctuation codes, below the letters


def _number(m: re.Match) -> str:
    """A run of digits as a marker, its length and the digits, so longer numbers sort later."""
    d = m.group().lstrip("0") or "0"
    return _NUM + chr(0x29 + min(len(d), 50)) + d


_cache: collections.OrderedDict[str, tuple[str, float, list[dict]]] = collections.OrderedDict()
_cache_lock = threading.Lock()


def name_key(name: str) -> str:
    """Sort key close to Intl.Collator(undefined, {numeric: true, sensitivity: "base"})."""
    if not name.isascii():
        name = "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))
    return _DIGITS.sub(_number, name.casefold().translate(_PUNCT))


def _kind_key(name: str, is_dir: bool) -> str:
    return name_key(" folder" if is_dir else name.rsplit(".", 1)[-1])


def _is_dir(de: os.DirEntry) -> bool:
    try:
        return de.is_dir()  # follows symlinks, like the listing's kind
    except OSError:
        return False


def sort_entries(entries: list[dict], key: str, direction: int, folders_first: bool) -> None:
    """Sort listing rows in place like the client's compare()."""
    if key == "mtime":
        k = lambda e: (e.get("mtime") or 0, name_key(e["name"]))  # noqa: E731
    elif key == "size":
        k = lambda e: (-1 if e["kind"] == "dir" else e.get("size") or 0, name_key(e["name"]))  # noqa: E731
    elif key == "kind":
        k = lambda e: (_kind_key(e["name"], e["kind"] == "dir"), name_key(e["name"]))  # noqa: E731
    else:
        k = lambda e: name_key(e["name"])  # noqa: E731
    entries.sort(key=k, reverse=direction < 0)
    if folders_first:
        entries.sort(key=lambda e: e["kind"] != "dir")  # stable: keeps the order inside each group


def _cached(path: str, mtime_ns: str) -> list[dict] | None:
    with _cache_lock:
        hit = _cache.get(path)
        if hit and hit[0] == mtime_ns and time.time() - hit[1] < CACHE_SECONDS:
            return hit[2]
    return None


def _remember(path: str, mtime_ns: str, entries: list[dict]) -> None:
    if len(entries) < CACHE_MIN:
        return
    with _cache_lock:
        _cache[path] = (mtime_ns, time.time(), entries)
        _cache.move_to_end(path)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)


@router.get("/list/stream")
def list_stream(path: str = Query(...), sort: Literal["name", "mtime", "size", "kind"] = "name",
                dir: int = Query(1, ge=-1, le=1), folders_first: bool = True, hidden: bool = False, q: str = "",
                offset: int = Query(0, ge=0), limit: int | None = Query(None, ge=1),
                include: list[str] = Query([]), reuse: bool = False) -> StreamingResponse:
    """NDJSON: {head: {path, parent, mtime_ns, writable, total}}; then the sorted rows offset..offset+limit as
    {entries: [...]} lines (while a sort waits for every stat: {progress: n} and, for a first page, the best
    page so far as {provisional: [...]} now and then), then as {extra: [...]} the rows
    named in `include` that fell outside the page; finally {done: true, next, complete}, `next` being the
    offset to go on from. `reuse` accepts a recent full read of the folder."""
    path = norm(path)
    try:
        st = os.stat(path)
        if not stat.S_ISDIR(st.st_mode):
            raise HTTPException(400, "not a directory")
        mtime_ns = str(st.st_mtime_ns)
        full = _cached(path, mtime_ns) if reuse else None
        if full is None:
            with os.scandir(path) as it:
                des = list(it)
    except OSError as e:
        raise os_error(e)
    needle = q.casefold()
    end = offset + limit if limit else None

    def wanted(name: str) -> bool:
        return (hidden or not name.startswith(".")) and (not needle or needle in name.casefold())

    head = {"path": path, "parent": os.path.dirname(path) if path != "/" else None, "mtime_ns": mtime_ns,
            "writable": os.access(path, os.W_OK)}
    line = lambda obj: json.dumps(obj, separators=(",", ":")) + "\n"  # noqa: E731

    def batches(rows, field="entries"):
        """Send rows in batches, stat'ing DirEntries on the way."""
        batch, t = [], time.monotonic()
        for r in rows:
            batch.append(dir_entry(r) if isinstance(r, os.DirEntry) else r)
            if len(batch) >= BATCH or time.monotonic() - t > BATCH_SECONDS:
                yield line({field: batch})
                batch, t = [], time.monotonic()
        if batch:
            yield line({field: batch})

    def window(rows: list, name):
        """The page, then the included rows that fell outside it."""
        yield from batches(rows[offset:end])
        if include:
            outside = rows[:offset] + (rows[end:] if end is not None else [])
            yield from batches([r for r in outside if name(r) in include], "extra")

    def gen():
        if full is not None:
            rows = [e for e in full if wanted(e["name"])]
            yield line({"head": {**head, "total": len(rows)}})
            sort_entries(rows, sort, dir, folders_first)
            yield from window(rows, lambda e: e["name"])
        elif sort == "name":
            # readdir knows names and folders, so only the rows sent need a stat
            rows = sorted((de for de in des if wanted(de.name)), key=lambda de: name_key(de.name), reverse=dir < 0)
            if folders_first:
                rows.sort(key=lambda de: not _is_dir(de))
            yield line({"head": {**head, "total": len(rows)}})
            yield from window(rows, lambda de: de.name)
        else:
            # every row needs a stat; read them all once, hidden too, so the cache serves any filter
            yield line({"head": {**head, "total": sum(wanted(de.name) for de in des)}})
            every, t, shown = [], time.monotonic(), time.monotonic()
            for i, de in enumerate(des):
                every.append(dir_entry(de))
                now = time.monotonic()
                if now - t > BATCH_SECONDS:
                    yield line({"progress": i + 1})
                    t = now
                if not offset and limit and now - shown > PROVISIONAL_SECONDS:
                    # a slow read: show the best first page among the rows read so far, refined as it goes
                    part = [e for e in every if wanted(e["name"])]
                    sort_entries(part, sort, dir, folders_first)
                    yield line({"provisional": part[:limit]})
                    shown = time.monotonic()
            _remember(path, mtime_ns, every)
            rows = [e for e in every if wanted(e["name"])]
            sort_entries(rows, sort, dir, folders_first)
            yield from window(rows, lambda e: e["name"])
        nxt = len(rows) if end is None else min(end, len(rows))
        yield line({"done": True, "next": nxt, "complete": nxt >= len(rows)})

    return StreamingResponse(gen(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
