"""Disk usage analyzer: a breadth-first scan kept in memory, queried while it runs, plus the archive list.

Worker processes (du_walk.py) list folders in parallel, which beats GNU du on a warm cache.
The scan counts like `du -x`: allocated blocks and apparent size together, hardlinks once, symlinks
not followed, one filesystem (other mounts become placeholders that can be scanned on demand).
Only big files are kept individually; the rest of each folder is a "smaller files" bucket, so even
a scan of / stays small. Archived paths (cleanup candidates, never deleted here) are left out of
snapshots and subtracted from their parents.
"""

from __future__ import annotations

import itertools
import json
import marshal
import os
import subprocess
import sys
import threading
import time
from collections import deque

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from . import du_walk
from .config import CONFIG_DIR
from .du_walk import BIG_FILE, TOP_FILES, list_dirs
from .fsutil import SKIP_DIRS, is_within, norm
from .models import PathBody

router = APIRouter(prefix="/api/du")

WORKERS = min(8, os.cpu_count() or 1)   # processes listing folders in parallel (0 or 1: in the scan thread)
MAX_SCANS = 3
IDLE_DROP = 30 * 60     # forget scans nobody looked at for this long
MAX_CHILDREN = 2000     # per folder in one snapshot; the rest is merged into "others"
NO_REST = (0, 0, 0)


class _Worker:
    """A `python du_walk.py` process answering folder-listing batches over its stdin/stdout."""

    def __init__(self, proc: subprocess.Popen):
        self.proc = proc

    @classmethod
    def start(cls) -> _Worker | None:
        try:
            # -I: don't pick up the user's site-packages or PYTHON* settings; the worker only needs the stdlib
            return cls(subprocess.Popen([sys.executable, "-I", du_walk.__file__], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, close_fds=True))
        except OSError:
            return None

    def call(self, paths: list[str]) -> list:
        data = marshal.dumps(paths)
        self.proc.stdin.write(len(data).to_bytes(4, "little") + data)
        self.proc.stdin.flush()
        head = self.proc.stdout.read(4)
        if len(head) < 4:
            raise EOFError("worker exited")
        return marshal.loads(self.proc.stdout.read(int.from_bytes(head, "little")))

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc.stdout.close()


class Node:
    """A folder in the scan. Totals cover the whole subtree, including the folder's own inode."""

    __slots__ = ("name", "parent", "depth", "dirs", "files", "rest", "apparent", "disk", "nfiles", "ndirs",
                 "mtime", "pending", "state")

    def __init__(self, name: str, parent: Node | None, apparent: int, disk: int, mtime: float,
                 state: str = "queued"):
        self.name = name
        self.parent = parent
        self.depth = parent.depth + 1 if parent else 0
        # empty containers are shared (None / ()) so the millions of leaf folders in a scan of / stay small
        self.dirs: dict[str, Node] | None = None
        self.files: tuple[tuple[str, int, int, float], ...] = ()  # (name, apparent, disk, mtime), biggest first
        self.rest: tuple[int, int, int] = NO_REST                  # smaller files: count, apparent, disk
        self.apparent = apparent
        self.disk = disk
        self.nfiles = 0
        self.ndirs = 0
        self.mtime = mtime
        self.pending = 1 if state == "queued" else 0        # folders in the subtree not scanned yet
        self.state = state                                  # queued | done | error | mount | skipped | dead

    def chain(self):
        n = self
        while n is not None:
            yield n
            n = n.parent

    def add(self, apparent: int, disk: int, nfiles: int, ndirs: int, pending: int) -> None:
        for n in self.chain():
            n.apparent += apparent
            n.disk += disk
            n.nfiles += nfiles
            n.ndirs += ndirs
            n.pending += pending


def _collect(deltas: dict[int, list], node: Node, *change: int) -> None:
    entry = deltas.get(id(node))
    if entry is None:
        deltas[id(node)] = [node, *change]
    else:
        for i, v in enumerate(change, 1):
            entry[i] += v


def _propagate(deltas: dict[int, list]) -> None:
    """Apply collected size changes to their folders and all ancestors, deepest first, so
    folders listed in the same batch walk their shared ancestors only once."""
    by_depth: dict[int, list] = {}
    for entry in deltas.values():
        by_depth.setdefault(entry[0].depth, []).append(entry)
    for depth in range(max(by_depth, default=-1), -1, -1):
        for node, apparent, disk, nfiles, ndirs, pending in by_depth.get(depth, ()):
            node.apparent += apparent
            node.disk += disk
            node.nfiles += nfiles
            node.ndirs += ndirs
            node.pending += pending
            parent = node.parent
            if parent is not None:
                up = deltas.get(id(parent))
                if up is None:
                    up = deltas[id(parent)] = [parent, 0, 0, 0, 0, 0]
                    by_depth.setdefault(depth - 1, []).append(up)
                up[1] += apparent
                up[2] += disk
                up[3] += nfiles
                up[4] += ndirs
                up[5] += pending


class Scan:
    def __init__(self, sid: str, root: str):
        self.id = sid
        self.root = root
        st = os.lstat(root)
        self.node = Node(root, None, st.st_size, st.st_blocks * 512, st.st_mtime)
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)   # drivers wait here for more folders
        self.busy = 0                                # batches being listed right now
        self.queue: deque[tuple[Node, str, int]] = deque([(self.node, root, st.st_dev)])  # node, path, device
        self.seen: dict[tuple[int, int], Node] = {}   # hardlinked inodes already counted, and where
        self.stop_flag = threading.Event()
        self.thread: threading.Thread | None = None
        self.started = time.time()
        self.finished: float | None = None
        self.last_poll = time.time()
        self.errors = 0
        self.scanned = 0
        self.current = root
        self.stopped = False
        self._ensure_running()

    # ------------------------------------------------------------ walking

    def _ensure_running(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop_flag.clear()
        self.stopped = False
        self.finished = None
        self.thread = threading.Thread(target=self._run, name=f"du-{self.id}", daemon=True)
        self.thread.start()

    def _run(self) -> None:
        """Feed folders to worker processes, one driver thread each (the threads wait on pipes, so
        the GIL isn't a bottleneck), and fold their listings into the tree as they come back."""
        workers = [_Worker.start() for _ in range(WORKERS)] if WORKERS > 1 else []
        workers = [w for w in workers if w] or [None]   # None: list folders in this thread
        self.busy = 0
        threads = [threading.Thread(target=self._drive, args=(w,), name=f"du-{self.id}-{i}", daemon=True)
                   for i, w in enumerate(workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        for w in workers:
            if w:
                w.close()
        self.finished = time.time()
        self.stopped = self.stop_flag.is_set()

    def _drive(self, worker: _Worker | None) -> None:
        slots = max(1, WORKERS) * 3
        while True:
            with self.wake:
                while not self.queue and self.busy and not self.stop_flag.is_set():
                    self.wake.wait(0.5)
                if self.stop_flag.is_set() or (not self.queue and not self.busy):
                    self.wake.notify_all()
                    return
                # bigger batches when the queue is long: fewer round trips to the workers
                k = max(1, min(256, len(self.queue) // slots))
                batch = []
                while self.queue and len(batch) < k:
                    item = self.queue.popleft()
                    if item[0].state == "queued":   # not rescanned or dropped meanwhile
                        batch.append(item)
                if not batch:
                    continue
                self.busy += 1
                self.current = batch[-1][1]
            paths = [path for _, path, _ in batch]
            listings = None
            if worker:
                try:
                    listings = worker.call(paths)
                except (OSError, EOFError, ValueError):   # the worker died: carry on in this thread
                    worker.close()
                    worker = None
            if listings is None:
                listings = list_dirs(paths)
            with self.wake:
                deltas: dict[int, list] = {}
                for (node, path, dev), listing in zip(batch, listings):
                    self._apply(node, path, dev, listing, deltas)
                _propagate(deltas)
                self.busy -= 1
                self.wake.notify_all()

    def _apply(self, node: Node, path: str, dev: int, listing, deltas: dict[int, list]) -> None:
        """Add one folder's listing to the tree (holding self.lock). Its size change is collected
        in `deltas` and passed up to the ancestors once per batch by _propagate."""
        if node.state != "queued":
            return
        if listing is None:
            node.state = "error"
            _collect(deltas, node, 0, 0, 0, 0, -1)
            self.errors += 1
            return
        dirs, big, links, n_small, small_size, small_disk, errors = listing
        rest = [n_small, small_size, small_disk]
        for dv, ino, name, size, disk, mtime in links:
            if (dv, ino) in self.seen:
                continue
            self.seen[(dv, ino)] = node
            if size >= BIG_FILE or disk >= BIG_FILE:
                big.append((name, size, disk, mtime))
            else:
                rest[0] += 1
                rest[1] += size
                rest[2] += disk
        big.sort(key=lambda f: max(f[1], f[2]), reverse=True)
        for f in big[TOP_FILES:]:
            rest[0] += 1
            rest[1] += f[1]
            rest[2] += f[2]
        node.files = tuple(big[:TOP_FILES])
        node.rest = tuple(rest) if rest[0] else NO_REST
        apparent = rest[1] + sum(f[1] for f in node.files)
        disk_total = rest[2] + sum(f[2] for f in node.files)
        queued = 0
        if dirs:
            node.dirs = {}
        prefix = path if path == "/" else path + "/"
        for name, size, disk, mtime, dv in dirs:
            full = prefix + name
            state = "mount" if dv != dev else "skipped" if full in SKIP_DIRS else "queued"
            if state == "queued":
                child = Node(name, node, size, disk, mtime)
                apparent += size
                disk_total += disk
                queued += 1
                self.queue.append((child, full, dev))
            else:
                child = Node(name, node, 0, 0, mtime, state)
            node.dirs[name] = child
        node.state = "done"
        _collect(deltas, node, apparent, disk_total, len(node.files) + rest[0], len(dirs), queued - 1)
        self.errors += errors
        self.scanned += 1

    # ------------------------------------------------------------ lookups and changes (hold self.lock)

    def find(self, path: str) -> Node | None:
        if not is_within(path, self.root):
            return None
        node = self.node
        rel = path[len(self.root):].strip("/")
        for part in rel.split("/") if rel else []:
            node = node.dirs.get(part) if node.dirs else None
            if node is None:
                return None
        return node

    def find_file(self, path: str) -> tuple[Node, tuple] | None:
        parent = self.find(os.path.dirname(path))
        name = os.path.basename(path)
        if parent:
            for f in parent.files:
                if f[0] == name:
                    return parent, f
        return None

    def rescan(self, node: Node, path: str) -> None:
        """Forget what was counted under `node` and walk it again."""
        dead: set[int] = set()
        stack = [node]
        while stack:
            n = stack.pop()
            dead.add(id(n))
            for c in (n.dirs or {}).values():
                c.state = "dead"
                stack.append(c)
        for key in [k for k, owner in self.seen.items() if id(owner) in dead]:
            del self.seen[key]
        if node.parent:
            node.parent.add(-node.apparent, -node.disk, -node.nfiles, -node.ndirs, -node.pending)
        try:
            st = os.lstat(path)
        except OSError:
            # gone: drop it from its parent (the root itself can't go away while scanned)
            if node.parent:
                node.parent.dirs.pop(node.name, None)
                node.parent.add(0, 0, 0, -1, 0)
                node.state = "dead"
            return
        node.dirs, node.files, node.rest = None, (), NO_REST
        node.apparent, node.disk, node.nfiles, node.ndirs, node.pending = st.st_size, st.st_blocks * 512, 0, 0, 1
        node.mtime = st.st_mtime
        node.state = "queued"
        if node.parent:
            node.parent.add(node.apparent, node.disk, 0, 0, 1)
        self.queue.append((node, path, st.st_dev))

    def status(self) -> dict:
        running = bool(self.thread and self.thread.is_alive())
        end = self.finished if not running and self.finished else time.time()
        return {"id": self.id, "root": self.root, "running": running, "stopped": self.stopped and bool(self.queue),
                "started": self.started, "elapsed": round(end - self.started, 2), "scanned": self.scanned,
                "errors": self.errors, "current": self.current if running else "",
                "apparent": self.node.apparent, "disk": self.node.disk,
                "files": self.node.nfiles, "dirs": self.node.ndirs}


_scans: dict[str, Scan] = {}
_ids = itertools.count(1)
_reg_lock = threading.Lock()


def _get(sid: str) -> Scan:
    scan = _scans.get(sid)
    if not scan:
        raise HTTPException(404, "scan expired; start it again")
    scan.last_poll = time.time()
    return scan


def _forget(scan: Scan) -> None:
    scan.stop_flag.set()
    _scans.pop(scan.id, None)


# ---------------------------------------------------------------- archive list

ARCHIVE_PATH = os.path.join(CONFIG_DIR, "archive.json")
_archive_lock = threading.Lock()


def load_archive() -> list[dict]:
    try:
        with open(ARCHIVE_PATH) as f:
            items = json.load(f).get("items", [])
        return [i for i in items if isinstance(i, dict) and isinstance(i.get("path"), str)]
    except (OSError, ValueError, AttributeError):
        return []


def _save_archive(items: list[dict]) -> None:
    os.makedirs(os.path.dirname(ARCHIVE_PATH), exist_ok=True)
    tmp = ARCHIVE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"items": items}, f, indent=1)
    os.replace(tmp, ARCHIVE_PATH)


def outermost(paths) -> list[str]:
    """Drop paths that lie inside another path of the list."""
    out: list[str] = []
    for p in sorted(set(paths)):
        if not out or not is_within(p, out[-1]):
            out.append(p)
    return out


def _archived_minus(scan: Scan, paths: list[str]) -> tuple[set[str], dict[int, list[int]]]:
    """Which archived paths fall in this scan, and how much to take off each ancestor folder."""
    hidden: set[str] = set()
    minus: dict[int, list[int]] = {}
    for p in outermost(paths):
        if not is_within(p, scan.root) or p == scan.root:
            continue
        node = scan.find(p)
        if node is not None:
            size = (node.apparent, node.disk, node.nfiles, node.ndirs, node.pending)
            parent = node.parent
            count_self = (0, 0, 0, 1, 0)
        else:
            hit = scan.find_file(p)
            if not hit:
                continue
            parent, f = hit
            size = (f[1], f[2], 1, 0, 0)
            count_self = (0, 0, 0, 0, 0)
        hidden.add(p)
        for n in parent.chain():
            m = minus.setdefault(id(n), [0, 0, 0, 0, 0])
            for i in range(5):
                m[i] += size[i] + count_self[i]
    return hidden, minus


# ---------------------------------------------------------------- snapshot

def _snapshot(scan: Scan, path: str, depth: int, metric: str, min_frac: float, expand: set[str],
              limit: int) -> dict | None:
    archived = [i["path"] for i in load_archive()]
    hidden, minus = _archived_minus(scan, archived)
    idx = 1 if metric == "apparent" else 2   # position in file tuples and the rest bucket
    tdx = idx - 1                             # position in totals()
    focus = scan.find(path)
    if focus is None:
        return None

    def totals(n: Node) -> list[int]:
        m = minus.get(id(n), (0, 0, 0, 0, 0))
        return [n.apparent - m[0], n.disk - m[1], n.nfiles - m[2], n.ndirs - m[3], n.pending - m[4]]

    focus_size = max(totals(focus)[tdx], 1)
    min_bytes = focus_size * min_frac

    def dir_dict(n: Node, p: str, level: int) -> dict:
        a, d, nf, nd, pend = totals(n)
        out = {"name": n.name if p != scan.root else p, "path": p, "kind": "dir", "apparent": a, "disk": d,
               "files": nf, "dirs": nd, "mtime": n.mtime, "complete": pend <= 0, "state": n.state,
               "expandable": bool(n.dirs or n.files or n.rest[0])}
        if level < depth or p in expand:
            out["children"] = children(n, p, level + 1)
        return out

    def children(n: Node, p: str, level: int) -> list[dict]:
        items: list[tuple[int, object]] = []
        for c in (n.dirs or {}).values():
            cp = os.path.join(p, c.name)
            if cp in hidden or c.state == "dead":
                continue
            items.append((totals(c)[tdx], ("dir", c, cp)))
        for f in n.files:
            fp = os.path.join(p, f[0])
            if fp in hidden:
                continue
            items.append((f[idx], ("file", f, fp)))
        if n.rest[0]:
            items.append((n.rest[idx], ("rest", n.rest, None)))
        items.sort(key=lambda t: t[0], reverse=True)
        out: list[dict] = []
        others = {"name": "", "kind": "others", "path": None, "apparent": 0, "disk": 0, "files": 0, "count": 0}
        for size, (kind, obj, cp) in items:
            if (size < min_bytes or len(out) >= limit) and kind != "rest":
                others["count"] += 1
                if kind == "dir":
                    t = totals(obj)
                    others["apparent"] += t[0]
                    others["disk"] += t[1]
                    others["files"] += t[2]
                else:
                    others["apparent"] += obj[1]
                    others["disk"] += obj[2]
                    others["files"] += 1
                continue
            if kind == "dir":
                out.append(dir_dict(obj, cp, level))
            elif kind == "file":
                out.append({"name": obj[0], "path": cp, "kind": "file", "apparent": obj[1], "disk": obj[2],
                            "files": 1, "mtime": obj[3]})
            else:
                out.append({"name": "", "path": None, "kind": "rest", "count": obj[0], "apparent": obj[1],
                            "disk": obj[2], "files": obj[0]})
        if others["count"]:
            out.append(others)
        return out

    return dir_dict(focus, path, 0)


# ---------------------------------------------------------------- endpoints

class ScanBody(BaseModel):
    path: str
    fresh: bool = False


@router.post("/scans")
def start_scan(body: ScanBody) -> dict:
    path = norm(body.path)
    if not os.path.isdir(path) or os.path.islink(path):
        raise HTTPException(400, "not a folder")
    with _reg_lock:
        now = time.time()
        for s in [s for s in _scans.values() if now - s.last_poll > IDLE_DROP]:
            _forget(s)
        existing = next((s for s in _scans.values() if s.root == path), None)
        if existing and not body.fresh:
            existing.last_poll = now
            return {**existing.status(), "reused": True}
        if existing:
            _forget(existing)
        while len(_scans) >= MAX_SCANS:
            _forget(min(_scans.values(), key=lambda s: s.last_poll))
        try:
            scan = Scan(str(next(_ids)), path)
        except OSError as e:
            raise HTTPException(403, f"{e.strerror}: {path}")
        _scans[scan.id] = scan
    return {**scan.status(), "reused": False}


@router.get("/scans/{sid}/tree")
def tree(sid: str, path: str = Query(None), depth: int = Query(4, ge=0, le=12),
         metric: str = Query("disk", pattern="^(disk|apparent)$"), min: float = Query(0.002, ge=0, le=1),
         expand: list[str] = Query([]), limit: int = Query(MAX_CHILDREN, ge=1, le=20000)) -> dict:
    scan = _get(sid)
    path = norm(path) if path else scan.root
    with scan.lock:
        snap = _snapshot(scan, path, depth, metric, min, set(expand), limit)
        status = scan.status()
    return {"status": status, "tree": snap}


@router.post("/scans/{sid}/rescan")
def rescan(sid: str, body: PathBody) -> dict:
    scan = _get(sid)
    path = norm(body.path)
    with scan.lock:
        node = scan.find(path)
        if node is None:
            raise HTTPException(404, "not in this scan")
        scan.rescan(node, path)
    scan._ensure_running()
    return scan.status()


@router.post("/scans/{sid}/include")
def include(sid: str, body: PathBody) -> dict:
    """Scan a mount point (or skipped folder) into the same tree."""
    scan = _get(sid)
    path = norm(body.path)
    with scan.lock:
        node = scan.find(path)
        if node is None or node.state not in ("mount", "skipped"):
            raise HTTPException(400, "not an unscanned mount point")
        node.state = "done"   # rescan() resets it to queued with fresh totals
        scan.rescan(node, path)
    scan._ensure_running()
    return scan.status()


@router.post("/scans/{sid}/stop")
def stop(sid: str) -> dict:
    scan = _get(sid)
    scan.stop_flag.set()
    if scan.thread:
        scan.thread.join(timeout=2)
    return scan.status()


@router.post("/scans/{sid}/resume")
def resume(sid: str) -> dict:
    scan = _get(sid)
    scan._ensure_running()
    return scan.status()


@router.delete("/scans/{sid}")
def drop(sid: str) -> dict:
    with _reg_lock:
        scan = _scans.get(sid)
        if scan:
            _forget(scan)
    return {"ok": True}


class ArchiveItem(BaseModel):
    path: str
    kind: str = "dir"
    apparent: int = 0
    disk: int = 0
    files: int = 0


class ArchiveBody(BaseModel):
    add: list[ArchiveItem] = []
    remove: list[str] = []


def _refresh_sizes(items: list[dict]) -> None:
    """Fill in current sizes from any scan that has counted the path."""
    for item in items:
        for scan in list(_scans.values()):
            with scan.lock:
                node = scan.find(item["path"])
                if node is not None and node.state != "dead":
                    item.update(apparent=node.apparent, disk=node.disk, files=node.nfiles,
                                complete=node.pending <= 0)
                    break
                hit = scan.find_file(item["path"])
                if hit:
                    item.update(apparent=hit[1][1], disk=hit[1][2], files=1, complete=True)
                    break


@router.get("/archive")
def get_archive() -> dict:
    items = load_archive()
    _refresh_sizes(items)
    for item in items:
        item["exists"] = os.path.lexists(item["path"])
    return {"items": items}


@router.post("/archive")
def change_archive(body: ArchiveBody) -> dict:
    with _archive_lock:
        items = load_archive()
        remove = {norm(p) for p in body.remove}
        items = [i for i in items if i["path"] not in remove]
        have = {i["path"] for i in items}
        now = time.time()
        for a in body.add:
            p = norm(a.path)
            if p == "/":
                raise HTTPException(400, "can't archive /")
            if p not in have:
                items.append({**a.model_dump(), "path": p, "at": now})
                have.add(p)
        _save_archive(items)
    return get_archive()
