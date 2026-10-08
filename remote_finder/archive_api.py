"""Compress (saved next to the sources), extract safely, and list archive contents."""

from __future__ import annotations

import os
import shutil
import subprocess
import tarfile
import zipfile
from typing import Literal

import zstandard
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from . import jobs
from .fsutil import is_within, norm, os_error, silent_unlink, split_ext, tree_size, unique_name
from .models import PathBody

router = APIRouter(prefix="/api")

Format = Literal["zip", "tar.xz", "tar.zst"]
EXTENSIONS = {"zip": ".zip", "tar.xz": ".tar.xz", "tar.zst": ".tar.zst"}


class CompressBody(BaseModel):
    paths: list[str]
    format: Format = "zip"


class _Counting:
    """File wrapper that reports bytes read to a job (so tar progress tracks input)."""

    def __init__(self, f, job: jobs.Job) -> None:
        self.f, self.job = f, job

    def read(self, n: int = -1) -> bytes:
        b = self.f.read(n)
        self.job.advance(len(b))
        return b


def _walk(paths: list[str]):
    """Yield (abs_path, arcname) for every entry, without following symlinks."""
    for p in paths:
        base = os.path.dirname(p)
        yield p, os.path.relpath(p, base)
        if os.path.isdir(p) and not os.path.islink(p):
            for root, dirs, files in os.walk(p):
                dirs.sort()
                for name in dirs + sorted(files):
                    full = os.path.join(root, name)
                    yield full, os.path.relpath(full, base)


def _write_zip(out: str, paths: list[str], job: jobs.Job) -> None:
    """Deflate at level 9; symlinks are stored as links, like `zip --symlinks`."""
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as zf:
        for full, arc in _walk(paths):
            if os.path.islink(full):
                info = zipfile.ZipInfo(arc)
                info.create_system = 3  # unix, so external_attr carries the mode
                info.external_attr = 0o120777 << 16
                zf.writestr(info, os.readlink(full))
            elif os.path.isdir(full):
                zf.write(full, arc)
            elif os.path.isfile(full):
                info = zipfile.ZipInfo.from_file(full, arc)
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(full, "rb") as src, zf.open(info, "w", force_zip64=True) as dst:
                    while chunk := src.read(1 << 20):
                        dst.write(chunk)
                        job.advance(len(chunk), arc)


def _write_tar(out: str, paths: list[str], job: jobs.Job, fmt: Format) -> None:
    """tar.xz through `xz -9e -T0` (multithreaded), or tar.zst at zstd level 19 on all cores."""
    proc = None
    if fmt == "tar.xz":
        with open(out, "wb") as xz_out:
            proc = subprocess.Popen(["xz", "-9e", "-T0", "-c"], stdin=subprocess.PIPE, stdout=xz_out)
        stream = proc.stdin
    else:
        stream = zstandard.ZstdCompressor(level=19, threads=-1).stream_writer(open(out, "wb"), closefd=True)
    try:
        with tarfile.open(fileobj=stream, mode="w|", format=tarfile.PAX_FORMAT) as tf:
            for full, arc in _walk(paths):
                ti = tf.gettarinfo(full, arc)
                if ti.isreg():
                    with open(full, "rb") as src:
                        tf.addfile(ti, _Counting(src, job))
                    job.message = arc
                else:
                    tf.addfile(ti)
                    job.check()
    finally:
        stream.close()
        if proc and proc.wait() != 0:
            raise RuntimeError("xz failed")


def _archive_stem(paths: list[str]) -> str:
    """Finder naming: one item -> its name; several -> 'Archive'."""
    if len(paths) > 1:
        return "Archive"
    name = os.path.basename(paths[0])
    return name if os.path.isdir(paths[0]) else split_ext(name)[0]


@router.post("/compress")
def compress(body: CompressBody) -> dict:
    paths = [norm(p) for p in body.paths]
    if not paths:
        raise HTTPException(400, "nothing to compress")
    parents = {os.path.dirname(p) for p in paths}
    if len(parents) != 1:
        raise HTTPException(400, "items must be in the same folder")
    folder = parents.pop()
    if not os.access(folder, os.W_OK):
        raise HTTPException(403, f"Folder is not writable: {folder}")
    final = unique_name(folder, _archive_stem(paths) + EXTENSIONS[body.format])
    # a hidden .part file is renamed when complete, so a half-written archive never looks finished
    part = os.path.join(folder, "." + os.path.basename(final) + ".part")

    def work(job: jobs.Job):
        job.total = sum(tree_size(p) for p in paths)
        if body.format == "zip":
            _write_zip(part, paths, job)
        else:
            _write_tar(part, paths, job, body.format)
        os.replace(part, final)
        return {"path": final}

    return jobs.start("compress", f"Compressing to {os.path.basename(final)}", work,
                      lambda: silent_unlink(part)).public()


# ---------------------------------------------------------------- extract

def _archive_kind(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".zip"):
        return "zip"
    if lower.endswith((".tar.zst", ".tzst")):
        return "tar.zst"
    if lower.endswith((".tar", ".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tbz2")):
        return "tar"
    if zipfile.is_zipfile(path):
        return "zip"
    if tarfile.is_tarfile(path):
        return "tar"
    raise HTTPException(400, "not a supported archive")


def _open_tar(path: str, kind: str) -> tarfile.TarFile:
    """Open as a forward-only stream (works for every compression, including zstd)."""
    if kind == "tar.zst":
        reader = zstandard.ZstdDecompressor().stream_reader(open(path, "rb"), closefd=True)
        return tarfile.open(fileobj=reader, mode="r|")
    return tarfile.open(path, "r|*")


def _safe_zip_extract(zf: zipfile.ZipFile, dest: str, job: jobs.Job) -> None:
    """Extract, refusing members or symlinks that would land outside `dest` (zip slip)."""
    root = os.path.realpath(dest)
    for info in zf.infolist():
        target = os.path.realpath(os.path.join(dest, info.filename))
        if os.path.isabs(info.filename) or not is_within(target, root):
            raise RuntimeError(f"blocked unsafe path in archive: {info.filename}")
        mode = info.external_attr >> 16
        if (mode & 0o170000) == 0o120000:  # symlink entry
            link = zf.read(info).decode()
            if not is_within(os.path.realpath(os.path.join(os.path.dirname(target), link)), root):
                raise RuntimeError(f"blocked symlink escaping archive: {info.filename}")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.symlink(link, target)
            continue
        zf.extract(info, dest)
        if mode & 0o777 and not info.is_dir():
            os.chmod(target, mode & 0o777)
        job.advance(info.file_size, info.filename)


@router.post("/extract")
def extract(body: PathBody) -> dict:
    path = norm(body.path)
    kind = _archive_kind(path)
    folder = os.path.dirname(path)
    if not os.access(folder, os.W_OK):
        raise HTTPException(403, f"Folder is not writable: {folder}")
    staging = os.path.join(folder, f".{os.path.basename(path)}.extracting")

    def work(job: jobs.Job):
        job.total = 0  # tar: compressed size doesn't predict extracted bytes; progress is indeterminate
        if os.path.lexists(staging):
            shutil.rmtree(staging)
        os.mkdir(staging)
        if kind == "zip":
            with zipfile.ZipFile(path) as zf:
                job.total = sum(i.file_size for i in zf.infolist())
                _safe_zip_extract(zf, staging, job)
        else:
            with _open_tar(path, kind) as tf:
                for member in tf:
                    tf.extract(member, staging, filter="data")
                    job.advance(member.size, member.name)
        # Finder: a single top-level item lands directly; several get wrapped in a folder
        names = os.listdir(staging)
        if len(names) == 1 and not os.path.lexists(os.path.join(folder, names[0])):
            result = os.path.join(folder, names[0])
            os.rename(os.path.join(staging, names[0]), result)
            os.rmdir(staging)
        else:
            result = unique_name(folder, split_ext(os.path.basename(path))[0])
            os.rename(staging, result)
        return {"path": result}

    return jobs.start("extract", f"Extracting {os.path.basename(path)}", work,
                      lambda: shutil.rmtree(staging, ignore_errors=True)).public()


@router.get("/archive/list")
def archive_list(path: str = Query(...), limit: int = 5000) -> dict:
    path = norm(path)
    kind = _archive_kind(path)
    items = []
    try:
        if kind == "zip":
            with zipfile.ZipFile(path) as zf:
                infos = zf.infolist()
            count = len(infos)
            items = [{"name": i.filename, "size": i.file_size, "csize": i.compress_size, "dir": i.is_dir()}
                     for i in infos[:limit]]
        else:
            count = 0
            with _open_tar(path, kind) as tf:
                for m in tf:
                    count += 1
                    if len(items) < limit:
                        items.append({"name": m.name, "size": m.size, "dir": m.isdir(), "link": m.linkname or None})
    except OSError as e:
        raise os_error(e)
    except (tarfile.TarError, zipfile.BadZipFile, zstandard.ZstdError) as e:
        raise HTTPException(400, f"cannot read archive: {e}")
    return {"path": path, "count": count, "items": items, "truncated": count > len(items)}
