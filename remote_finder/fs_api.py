"""Read-only filesystem API: listing, info, raw files, zip downloads, disks, folder sizes."""

from __future__ import annotations

import json
import os
import socket
import stat
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Callable
from urllib.parse import quote

import psutil
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from zipstream import ZIP_DEFLATED, ZipStream

from . import jobs
from .fsutil import SKIP_DIRS, describe, dir_entry, group_name, guess_mime, norm, os_error, user_name
from .models import PathBody, PathsBody
from .security import raw_headers

router = APIRouter(prefix="/api")


@router.get("/list")
def list_dir(path: str = Query(...)) -> dict:
    path = norm(path)
    try:
        st = os.stat(path)
        if not stat.S_ISDIR(st.st_mode):
            raise HTTPException(400, "not a directory")
        with os.scandir(path) as it:
            entries = [dir_entry(de) for de in it]
    except OSError as e:
        raise os_error(e)
    return {
        "path": path,
        "parent": os.path.dirname(path) if path != "/" else None,
        "mtime_ns": str(st.st_mtime_ns),  # string: exceeds JS integer precision
        "writable": os.access(path, os.W_OK),
        "entries": entries,
    }


@router.get("/mtime")
def dir_mtime(path: str = Query(...)) -> dict:
    """Cheap change check the client polls to auto-refresh the open folder."""
    try:
        return {"mtime_ns": str(os.stat(norm(path)).st_mtime_ns)}
    except OSError as e:
        raise os_error(e)


@router.get("/stat")
def stat_path(path: str = Query(...)) -> dict:
    path = norm(path)
    try:
        lst = os.lstat(path)
    except OSError as e:
        raise os_error(e)
    info, st = describe(path, lst, lambda: os.stat(path))
    if info.get("link") and not info.get("broken"):
        info["resolved"] = os.path.realpath(path)
    info.update(
        path=path, name=os.path.basename(path) or "/",
        size=st.st_size, ctime=st.st_ctime, atime=st.st_atime,
        octal=oct(stat.S_IMODE(st.st_mode))[2:].zfill(4),
        owner=user_name(st.st_uid), group=group_name(st.st_gid), inode=st.st_ino, nlink=st.st_nlink,
        mtime_ns=str(st.st_mtime_ns),
        readable=os.access(path, os.R_OK), writable=os.access(path, os.W_OK),
    )
    return info


@router.get("/raw")
def raw(path: str = Query(...), download: bool = False, render: bool = False):
    """A file's bytes (HTTP Range supported), with sandboxing headers for active content."""
    path = norm(path)
    try:
        st = os.stat(path)
    except OSError as e:
        raise os_error(e)
    if not stat.S_ISREG(st.st_mode):
        raise HTTPException(400, "not a regular file")
    if not os.access(path, os.R_OK):
        raise HTTPException(403, f"Permission denied: {path}")
    media_type, headers = raw_headers(guess_mime(path), render)
    return FileResponse(path, media_type=media_type, headers=headers,
                        filename=os.path.basename(path) if download else None,
                        content_disposition_type="attachment" if download else "inline")


@router.get("/render/{path:path}")
def render(path: str):
    """A file for a rendered page, addressed by path so the page's relative links (media/x.mp4) resolve
    to its neighbours. HTML runs sandboxed exactly as with /raw?render=1."""
    return raw("/" + path, render=True)


@router.get("/download")
def download(paths: list[str] = Query(...)):
    """Stream one or more files/folders as a zip (nothing written on the server)."""
    paths = [norm(p) for p in paths]
    for p in paths:
        if not os.path.lexists(p):
            raise HTTPException(404, f"not found: {p}")
    if len(paths) == 1 and os.path.isfile(paths[0]):
        return raw(paths[0], download=True)
    zs = ZipStream(compress_type=ZIP_DEFLATED, compress_level=6, sized=False)
    for p in paths:
        zs.add_path(p, os.path.basename(p) or "root")
    name = (os.path.basename(paths[0]) or "root") + ".zip" if len(paths) == 1 else "Archive.zip"
    return StreamingResponse(iter(zs), media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name, safe='')}"})


@router.get("/home")
def home() -> dict:
    return {"home": os.path.expanduser("~"), "user": user_name(os.getuid()), "host": socket.gethostname()}


SKIP_FSTYPES = {"squashfs", "tmpfs", "devtmpfs", "overlay", "proc", "sysfs", "cgroup", "cgroup2", "efivarfs"}


@router.get("/disks")
def disks() -> list[dict]:
    """Real mounted filesystems with usage (no snaps, loop devices, tmpfs...)."""
    out, seen = [], set()
    for part in psutil.disk_partitions(all=False):
        mp = part.mountpoint
        if part.fstype in SKIP_FSTYPES or mp.startswith(("/snap", "/boot", "/var/lib/docker")) or mp in seen:
            continue
        seen.add(mp)
        try:
            u = psutil.disk_usage(mp)
        except OSError:
            continue
        out.append({"mount": mp, "device": part.device, "fstype": part.fstype,
                    "total": u.total, "used": u.used, "free": u.free})
    return out


def folder_size(path: str, tick: Callable[[int, int], None] = lambda total, files: None) -> dict:
    """Apparent size of a folder: hardlinks once, no symlinks, no pseudo filesystems.
    tick(total, files) runs after each directory and may raise to stop."""
    total = files = dirs = errors = 0
    seen: set[tuple[int, int]] = set()
    stack = [path]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for de in it:
                    try:
                        st = de.stat(follow_symlinks=False)
                    except OSError:
                        errors += 1
                        continue
                    if de.is_dir(follow_symlinks=False):
                        if de.path not in SKIP_DIRS:
                            stack.append(de.path)
                            dirs += 1
                        continue
                    if st.st_nlink > 1:
                        key = (st.st_dev, st.st_ino)
                        if key in seen:
                            continue
                        seen.add(key)
                    total += st.st_size
                    files += 1
        except OSError:
            errors += 1
        tick(total, files)
    return {"path": path, "size": total, "files": files, "dirs": dirs, "errors": errors}


@router.post("/du")
def du(body: PathBody) -> dict:
    """Folder size as a job (see folder_size)."""
    path = norm(body.path)
    if not os.path.isdir(path):
        raise HTTPException(400, "not a folder")

    def work(job: jobs.Job):
        def tick(total: int, files: int):
            job.done = total
            job.message = f"{files:,} files"
            job.check()
        return folder_size(path, tick)

    return jobs.start("du", f"Calculating size of {os.path.basename(path) or '/'}", work).public()


class _Stopped(Exception):
    pass


@router.post("/sizes")
def sizes(body: PathsBody):
    """NDJSON stream of folder sizes, several folders at a time, each line as soon as its folder is done.
    Lines: {path, size, files, errors} or {path, error}; {partial: {path: bytes so far}} about once a second."""
    paths = list(dict.fromkeys(norm(p) for p in body.paths))
    stop = threading.Event()
    running: dict[str, int] = {}

    def one(path: str) -> dict | None:
        def tick(total: int, files: int):
            if stop.is_set():
                raise _Stopped
            running[path] = total
        running[path] = 0
        try:
            if not os.path.isdir(path):
                return {"path": path, "error": "not a folder"}
            return folder_size(path, tick)
        except _Stopped:
            return None
        finally:
            running.pop(path, None)

    def gen():
        pool = ThreadPoolExecutor(4, thread_name_prefix="sizes")
        try:
            pending = {pool.submit(one, p) for p in paths}
            while pending:
                done, pending = wait(pending, timeout=1, return_when=FIRST_COMPLETED)
                for f in done:
                    if (r := f.result()) is not None:
                        yield json.dumps(r) + "\n"
                if pending and running:
                    yield json.dumps({"partial": dict(running)}) + "\n"  # also notices a closed connection
        finally:
            stop.set()
            pool.shutdown(wait=False, cancel_futures=True)

    return StreamingResponse(gen(), media_type="application/x-ndjson")
