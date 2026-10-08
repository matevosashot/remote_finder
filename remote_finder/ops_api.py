"""File operations: create, rename, delete, copy/move, upload, save."""

from __future__ import annotations

import os
import shutil
import stat
import tempfile
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from . import jobs
from .fsutil import check_name, is_within, norm, os_error, remove_path, silent_unlink, tree_size, unique_name
from .models import Conflict, PathsBody

router = APIRouter(prefix="/api")


class MkdirBody(BaseModel):
    dir: str
    name: str = "untitled folder"
    file: bool = False  # create an empty file instead


@router.post("/mkdir")
def mkdir(body: MkdirBody) -> dict:
    target = unique_name(norm(body.dir), check_name(body.name))
    try:
        if body.file:
            with open(target, "x"):
                pass
        else:
            os.mkdir(target)
    except OSError as e:
        raise os_error(e)
    return {"path": target}


class RenameBody(BaseModel):
    path: str
    name: str


@router.post("/rename")
def rename(body: RenameBody) -> dict:
    src = norm(body.path)
    dst = os.path.join(os.path.dirname(src), check_name(body.name))
    if dst == src:
        return {"path": dst}
    if os.path.lexists(dst):
        raise HTTPException(409, f"“{body.name}” already exists")
    try:
        os.rename(src, dst)
    except OSError as e:
        raise os_error(e)
    return {"path": dst}


@router.post("/delete")
def delete(body: PathsBody) -> dict:
    """Permanent delete (there is no trash), as a job."""
    paths = [norm(p) for p in body.paths]
    if "/" in paths:
        raise HTTPException(400, "refusing to delete /")

    def work(job: jobs.Job):
        job.total = len(paths)
        for p in paths:
            remove_path(p)
            job.advance(1, os.path.basename(p))
        return {"deleted": len(paths)}

    return jobs.start("delete", f"Deleting {len(paths)} item(s)", work).public()


class ConflictsBody(BaseModel):
    dest: str
    names: list[str]


@router.post("/conflicts")
def conflicts(body: ConflictsBody) -> dict:
    """Which of `names` already exist in `dest` (asked before copy/move/upload)."""
    dest = norm(body.dest)
    return {"conflicts": [n for n in body.names if os.path.lexists(os.path.join(dest, n))]}


class TransferBody(BaseModel):
    op: Literal["copy", "move"]
    sources: list[str]
    dest: str
    conflict: Conflict = "keep"          # default for names without a decision
    decisions: dict[str, Conflict] = {}  # per-name answers from the conflict dialog


def _target(dest: str, name: str, src: str, action: Conflict) -> str | None:
    """Where `src` lands in `dest`, applying the conflict action; None means skip."""
    target = os.path.join(dest, name)
    if not os.path.lexists(target):
        return target
    if action == "skip":
        return None
    if action == "keep" or target == src:
        return unique_name(dest, name)
    remove_path(target)
    return target


def _copy(src: str, target: str, job: jobs.Job) -> None:
    """Copy a file, symlink or tree (symlinks copied as links), reporting bytes to the job."""
    def copy_file(s, d, *, follow_symlinks=True):
        r = shutil.copy2(s, d, follow_symlinks=follow_symlinks)
        try:
            job.advance(os.lstat(s).st_size, os.path.basename(s))
        except OSError:
            job.check()
        return r

    if os.path.isdir(src) and not os.path.islink(src):
        shutil.copytree(src, target, symlinks=True, copy_function=copy_file)
    else:
        copy_file(src, target, follow_symlinks=False)


@router.post("/transfer")
def transfer(body: TransferBody) -> dict:
    sources = [norm(s) for s in body.sources]
    dest = norm(body.dest)
    if not os.path.isdir(dest):
        raise HTTPException(400, "destination is not a folder")
    for s in sources:
        if is_within(dest, s):
            raise HTTPException(400, f"cannot {body.op} “{os.path.basename(s)}” into itself")

    def work(job: jobs.Job):
        job.total = sum(tree_size(s) for s in sources) if body.op == "copy" else len(sources)
        placed = []
        for src in sources:
            name = os.path.basename(src)
            if body.op == "move" and os.path.dirname(src) == dest:
                continue  # already here
            target = _target(dest, name, src, body.decisions.get(name, body.conflict))
            if target is None:
                continue
            if body.op == "copy":
                _copy(src, target, job)
            else:
                shutil.move(src, target)
                job.advance(1, name)
            placed.append(target)
        return {"paths": placed}

    verb = "Copying" if body.op == "copy" else "Moving"
    return jobs.start(body.op, f"{verb} {len(sources)} item(s)", work).public()


@router.post("/upload")
async def upload(request: Request, dir: str = Query(...), relpath: str = Query(...),
                 conflict: Conflict = "replace") -> dict:
    """Stream the raw request body to dir/relpath (relpath may contain sub-folders)."""
    base = norm(dir)
    parts = [p for p in relpath.split("/") if p]
    if not parts or any(p in (".", "..") or "\x00" in p for p in parts):
        raise HTTPException(400, "invalid relative path")
    target = os.path.join(base, *parts)
    parent = os.path.dirname(target)
    try:
        os.makedirs(parent, exist_ok=True)
    except OSError as e:
        raise os_error(e)
    if os.path.lexists(target):
        if conflict == "skip":
            return {"path": target, "skipped": True}
        if conflict == "keep":
            target = unique_name(parent, parts[-1])
    # write next to the target and rename when complete, so a half upload never looks finished
    tmp = os.path.join(parent, f".{os.path.basename(target)}.part")
    try:
        with open(tmp, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        os.replace(tmp, target)
    except OSError as e:
        silent_unlink(tmp)
        raise os_error(e)
    except BaseException:
        silent_unlink(tmp)
        raise
    return {"path": target}


class SaveBody(BaseModel):
    path: str
    content: str
    mtime_ns: str | None = None  # what the editor loaded (as a string); None = don't check
    force: bool = False


@router.post("/save")
def save(body: SaveBody) -> dict:
    """Atomic save from the editor: temp file + rename, keeping permissions."""
    path = norm(body.path)
    try:
        st = os.stat(path)
    except FileNotFoundError:
        st = None
    except OSError as e:
        raise os_error(e)
    if st and body.mtime_ns and not body.force and str(st.st_mtime_ns) != body.mtime_ns:
        raise HTTPException(409, "file changed on disk since it was opened")
    try:
        fd, tmp = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=os.path.dirname(path))
    except OSError as e:
        raise os_error(e)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(body.content)
        if st:
            os.chmod(tmp, stat.S_IMODE(st.st_mode))
        os.replace(tmp, path)
    except OSError as e:
        silent_unlink(tmp)
        raise os_error(e)
    return {"path": path, "mtime_ns": str(os.stat(path).st_mtime_ns), "saved": time.time()}
