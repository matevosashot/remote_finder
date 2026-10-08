"""Read-only filesystem API: listing, info, raw files, zip downloads, disks, folder sizes."""

from __future__ import annotations

import os
import socket
import stat
from urllib.parse import quote

import psutil
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from zipstream import ZIP_DEFLATED, ZipStream

from . import jobs
from .fsutil import SKIP_DIRS, describe, dir_entry, group_name, guess_mime, norm, os_error, user_name
from .models import PathBody
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


@router.post("/du")
def du(body: PathBody) -> dict:
    """Folder size as a job: apparent size, hardlinks once, no symlinks, no pseudo filesystems."""
    path = norm(body.path)
    if not os.path.isdir(path):
        raise HTTPException(400, "not a folder")

    def work(job: jobs.Job):
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
            job.done = total
            job.message = f"{files:,} files"
            job.check()
        return {"path": path, "size": total, "files": files, "dirs": dirs, "errors": errors}

    return jobs.start("du", f"Calculating size of {os.path.basename(path) or '/'}", work).public()
