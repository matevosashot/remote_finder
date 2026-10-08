"""Filename search (streamed) and a bounded walk for quick open. No index; walks on demand."""

from __future__ import annotations

import fnmatch
import json
import os
import time
from collections import deque

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from .fsutil import SKIP_DIRS, dir_entry, norm

router = APIRouter(prefix="/api")


def _bfs(root: str, max_depth: int, hidden: bool):
    """Breadth-first walk yielding (DirEntry, is_dir, depth). Skips pseudo filesystems and symlinked dirs."""
    queue = deque([(root, 0)])
    while queue:
        d, depth = queue.popleft()
        try:
            with os.scandir(d) as it:
                entries = sorted(it, key=lambda e: e.name.lower())
        except OSError:
            continue
        for de in entries:
            if not hidden and de.name.startswith("."):
                continue
            try:
                is_dir = de.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            yield de, is_dir, depth + 1
            if is_dir and depth + 1 < max_depth and de.path not in SKIP_DIRS:
                queue.append((de.path, depth + 1))


@router.get("/search")
def search(root: str = Query(...), q: str = Query(..., min_length=1), limit: int = 1000,
           hidden: bool = True, max_depth: int = 64):
    """NDJSON stream of matches: substring (case-insensitive) or glob when q contains * ? [."""
    root = norm(root)
    glob = any(c in q for c in "*?[")
    needle = q.lower()

    def gen():
        found = scanned = 0
        t0 = time.monotonic()
        last_beat = t0
        for de, _is_dir, _depth in _bfs(root, max_depth, hidden):
            scanned += 1
            path = de.path
            name = de.name.lower()
            hit = fnmatch.fnmatch(name, needle) if glob else needle in name
            if hit:
                found += 1
                yield json.dumps({**dir_entry(de), "path": path}) + "\n"
                if found >= limit:
                    break
            now = time.monotonic()
            if now - last_beat > 0.5:  # progress heartbeat
                last_beat = now
                yield json.dumps({"progress": scanned, "dir_now": os.path.dirname(path)}) + "\n"
            if now - t0 > 120:
                break
        yield json.dumps({"done": True, "found": found, "scanned": scanned}) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@router.get("/walk")
def walk(root: str = Query(...), max_entries: int = Query(50_000, le=200_000), max_depth: int = 6,
         hidden: bool = False) -> dict:
    """Relative paths under root for client-side fuzzy quick open (dirs end with '/')."""
    root = norm(root)
    out = []
    prefix = len(root.rstrip("/")) + 1
    deadline = time.monotonic() + 10
    truncated = False
    for de, is_dir, _depth in _bfs(root, max_depth, hidden):
        out.append(de.path[prefix:] + ("/" if is_dir else ""))
        if len(out) >= max_entries or time.monotonic() > deadline:
            truncated = True
            break
    return {"root": root, "paths": out, "truncated": truncated}
