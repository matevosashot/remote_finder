"""Image thumbnails (WebP), cached on disk by path + mtime + size."""

from __future__ import annotations

import hashlib
import io
import os

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

from .config import CACHE_DIR
from .fsutil import norm, os_error

router = APIRouter(prefix="/api")

THUMB_DIR = os.path.join(CACHE_DIR, "thumbs")
MAX_SOURCE = 200 * 1024 * 1024
BUCKETS = (128, 256, 512, 1024)  # requested sizes round up to one of these, so the cache is shared


def _render(path: str, size: int) -> bytes:
    with Image.open(path) as im:
        im.draft("RGB", (size, size))  # fast JPEG downscale
        im = ImageOps.exif_transpose(im)
        im.thumbnail((size, size))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA")
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=80)
        return buf.getvalue()


@router.get("/thumb")
def thumb(path: str = Query(...), size: int = Query(256, ge=16, le=1024)):
    path = norm(path)
    try:
        st = os.stat(path)
    except OSError as e:
        raise os_error(e)
    if st.st_size > MAX_SOURCE:
        raise HTTPException(413, "too large for a thumbnail")
    bucket = next(b for b in BUCKETS if size <= b)
    key = hashlib.sha1(f"{path}\0{st.st_mtime_ns}\0{st.st_size}\0{bucket}".encode()).hexdigest()
    cached = os.path.join(THUMB_DIR, key[:2], key + ".webp")
    if not os.path.exists(cached):
        try:
            data = _render(path, bucket)
        except Exception as e:
            raise HTTPException(415, f"cannot thumbnail: {e}")
        os.makedirs(os.path.dirname(cached), exist_ok=True)
        tmp = cached + f".{os.getpid()}.tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, cached)
    return FileResponse(cached, media_type="image/webp", headers={"Cache-Control": "max-age=86400"})
