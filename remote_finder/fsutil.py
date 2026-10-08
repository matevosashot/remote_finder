"""Filesystem helpers shared by the API modules: paths, names, MIME guesses, entry metadata."""

from __future__ import annotations

import functools
import grp
import mimetypes
import os
import pwd
import shutil
import stat
from typing import Callable

from fastapi import HTTPException

# Pseudo filesystems that recursive walks (search, du, quick open) never enter.
SKIP_DIRS = {"/proc", "/sys", "/dev", "/run"}

TEXT_EXTS = {
    ".txt", ".log", ".md", ".markdown", ".rst", ".py", ".pyi", ".js", ".mjs", ".cjs", ".ts", ".tsx",
    ".jsx", ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
    ".sh", ".bash", ".zsh", ".fish", ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".cu", ".cuh", ".java",
    ".kt", ".go", ".rs", ".rb", ".pl", ".php", ".lua", ".r", ".jl", ".sql", ".css", ".scss", ".less",
    ".html", ".htm", ".xml", ".svg", ".csv", ".tsv", ".diff", ".patch", ".dockerfile", ".cmake",
    ".gradle", ".properties", ".proto", ".tex", ".bib", ".gitignore", ".gitattributes", ".lock",
    ".srt", ".vtt", ".service", ".ipynb", ".tf", ".hcl", ".vue", ".svelte", ".swift", ".m", ".scala",
}
TEXT_NAMES = {"makefile", "dockerfile", "readme", "license", "changelog", "cmakelists.txt", "procfile",
              ".bashrc", ".zshrc", ".profile", ".vimrc", ".gitconfig", "requirements.txt"}
ARCHIVE_SUFFIXES = (".tar.gz", ".tar.xz", ".tar.zst", ".tar.bz2")

mimetypes.add_type("text/markdown", ".md")
mimetypes.add_type("text/x-python", ".py")
mimetypes.add_type("application/x-ipynb+json", ".ipynb")
mimetypes.add_type("text/x-yaml", ".yaml")
mimetypes.add_type("text/x-yaml", ".yml")
mimetypes.add_type("text/x-toml", ".toml")
mimetypes.add_type("application/zstd", ".zst")
mimetypes.add_type("text/plain", ".log")


# ---------------------------------------------------------------- paths and names

def norm(path: str | None) -> str:
    """Normalize a client-supplied absolute path."""
    if not path or not path.startswith("/"):
        raise HTTPException(400, "path must be absolute")
    if "\x00" in path:
        raise HTTPException(400, "invalid path")
    return "/" + os.path.normpath(path).lstrip("/")


def is_within(path: str, root: str) -> bool:
    """True if `path` is `root` or lies inside it (both normalized)."""
    return path == root or path.startswith(root.rstrip("/") + "/")


def check_name(name: str) -> str:
    """Validate a single file name typed by the user."""
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\x00" in name:
        raise HTTPException(400, "invalid name")
    return name


def split_ext(name: str) -> tuple[str, str]:
    """Split a name keeping multi-part archive suffixes together ('a.tar.gz' -> ('a', '.tar.gz'))."""
    lower = name.lower()
    for suffix in ARCHIVE_SUFFIXES:
        if lower.endswith(suffix) and len(name) > len(suffix):
            return name[: -len(suffix)], name[-len(suffix):]
    return os.path.splitext(name)


def unique_name(directory: str, name: str) -> str:
    """Finder-style free name: 'x.zip' -> 'x 2.zip' -> 'x 3.zip' ..."""
    candidate = os.path.join(directory, name)
    if not os.path.lexists(candidate):
        return candidate
    stem, ext = split_ext(name)
    i = 2
    while os.path.lexists(candidate := os.path.join(directory, f"{stem} {i}{ext}")):
        i += 1
    return candidate


# ---------------------------------------------------------------- types and metadata

def guess_mime(path: str) -> str:
    mime, _ = mimetypes.guess_type(path, strict=False)
    if mime:
        return mime
    return "text/plain" if is_text_name(path) else "application/octet-stream"


def is_text_name(path: str) -> bool:
    name = os.path.basename(path).lower()
    ext = os.path.splitext(name)[1]
    return ext in TEXT_EXTS or name in TEXT_NAMES or (name.startswith(".") and ext == "")


def kind_of(mode: int) -> str:
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISLNK(mode):
        return "link"
    if stat.S_ISFIFO(mode):
        return "fifo"
    if stat.S_ISSOCK(mode):
        return "socket"
    if stat.S_ISCHR(mode) or stat.S_ISBLK(mode):
        return "device"
    return "other"


@functools.lru_cache(maxsize=512)
def user_name(uid: int) -> str:
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


@functools.lru_cache(maxsize=512)
def group_name(gid: int) -> str:
    try:
        return grp.getgrgid(gid).gr_name
    except KeyError:
        return str(gid)


def describe(path: str, lst: os.stat_result, follow: Callable[[], os.stat_result]) -> tuple[dict, os.stat_result]:
    """Fields common to listings and Get Info, from an lstat result.

    Symlinks are resolved with `follow()`; a broken link keeps its own lstat.
    Returns (fields, the stat the fields describe).
    """
    info: dict = {}
    st = lst
    if stat.S_ISLNK(lst.st_mode):
        info["link"] = True
        try:
            info["target"] = os.readlink(path)
        except OSError:
            pass
        try:
            st = follow()
        except OSError:
            info["broken"] = True
    kind = kind_of(st.st_mode)
    info.update(kind=kind, mtime=st.st_mtime, perm=stat.filemode(st.st_mode))
    if kind == "file":
        info["mime"] = guess_mime(path)
        if is_text_name(path) or info["mime"].startswith("text/"):
            info["text"] = True
    return info, st


def dir_entry(de: os.DirEntry) -> dict:
    """One row of a folder listing (or of search results)."""
    item: dict = {"name": de.name, "hidden": de.name.startswith(".")}
    try:
        lst = de.stat(follow_symlinks=False)
    except OSError as e:
        item.update(kind="other", size=0, mtime=0, error=e.strerror)
        return item
    info, st = describe(de.path, lst, de.stat)
    item.update(info, size=st.st_size if info["kind"] == "file" else 0)
    return item


# ---------------------------------------------------------------- tree operations

def remove_path(path: str) -> None:
    """Delete a file, symlink (never its target) or folder tree."""
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def silent_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def tree_size(path: str) -> int:
    """Apparent size of a file, or of every file under a folder (symlinks not followed)."""
    if not os.path.isdir(path) or os.path.islink(path):
        try:
            return os.lstat(path).st_size
        except OSError:
            return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def os_error(e: OSError) -> HTTPException:
    if isinstance(e, PermissionError):
        code = 403
    elif isinstance(e, FileNotFoundError):
        code = 404
    elif isinstance(e, (FileExistsError, IsADirectoryError, NotADirectoryError)):
        code = 409
    else:
        code = 500
    return HTTPException(code, f"{e.strerror or e}: {e.filename or ''}".strip(": "))
