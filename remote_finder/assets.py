"""Versioned asset URLs for the HTML pages, so browsers cache JS/CSS forever and still see edits at once.

Each page is rewritten on the way out: local css/js/vendor URLs get `?v=<content hash>`, an import map
sends every module import to its versioned URL (relative imports in the JS stay untouched), and
modulepreload links fetch the page's whole import graph in parallel instead of level by level.
The page itself is never cached, so a changed file shows up on the next load with a new hash."""

from __future__ import annotations

import hashlib
import html
import json
import os
import re

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
PAGES = ("index.html", "du.html", "viewer.html", "editor.html", "tail.html")

_URL = re.compile(r'''(href|src)="(/(?:css|js|vendor)/[^"?#]+)"''')
_IMPORT = re.compile(r'''(?:^|[;\s])(?:import|export)\s[^;]*?from\s*["'](\.{1,2}/[^"']+)["']|^\s*import\s*["'](\.{1,2}/[^"']+)["']''', re.M)
_ENTRY = re.compile(r'<script type="module" src="(/js/[^"?]+)"')

_hashes: dict[str, tuple[tuple[int, int], str]] = {}
_imports: dict[str, tuple[tuple[int, int], list[str]]] = {}


def _stamp(path: str) -> tuple[int, int] | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size


def version(url: str, root: str | None = None) -> str | None:
    """Short content hash of a static file (`/js/app.js`), memoized until the file changes."""
    path = os.path.join(root or STATIC, url.lstrip("/"))
    stamp = _stamp(path)
    if stamp is None:
        return None
    hit = _hashes.get(path)
    if hit and hit[0] == stamp:
        return hit[1]
    with open(path, "rb") as f:
        digest = hashlib.sha1(f.read()).hexdigest()[:10]
    _hashes[path] = (stamp, digest)
    return digest


def versioned(url: str, root: str | None = None) -> str:
    v = version(url, root)
    return f"{url}?v={v}" if v else url


def modules(root: str | None = None) -> list[str]:
    """Every JS module under static/js, as URLs."""
    base = os.path.join(root or STATIC, "js")
    out = []
    for dirpath, _, names in os.walk(base):
        for n in names:
            if n.endswith(".js"):
                rel = os.path.relpath(os.path.join(dirpath, n), root or STATIC)
                out.append("/" + rel.replace(os.sep, "/"))
    return sorted(out)


def static_imports(url: str, root: str | None = None) -> list[str]:
    """URLs a module imports statically (dynamic import() is left to load on demand)."""
    path = os.path.join(root or STATIC, url.lstrip("/"))
    stamp = _stamp(path)
    hit = _imports.get(path)
    if hit and hit[0] == stamp:
        return hit[1]
    try:
        with open(path, encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return []
    out = []
    for m in _IMPORT.finditer(src):
        spec = m.group(1) or m.group(2)
        out.append(os.path.normpath(os.path.join(os.path.dirname(url), spec)).replace(os.sep, "/"))
    _imports[path] = (stamp, out)
    return out


def graph(entry: str, root: str | None = None) -> list[str]:
    """The entry module and everything it imports statically, breadth first."""
    seen, queue = [entry], [entry]
    while queue:
        for dep in static_imports(queue.pop(0), root):
            if dep not in seen:
                seen.append(dep)
                queue.append(dep)
    return seen


def render_page(name: str, boot: dict | None = None, root: str | None = None) -> str:
    with open(os.path.join(root or STATIC, name), encoding="utf-8") as f:
        page = f.read()
    entries = _ENTRY.findall(page)
    page = _URL.sub(lambda m: f'{m.group(1)}="{html.escape(versioned(m.group(2), root))}"', page)
    imap = {"imports": {u: versioned(u, root) for u in modules(root)}}
    head = [f'<script type="importmap">{_json(imap)}</script>']
    preload = []
    for entry in entries:
        preload += [u for u in graph(entry, root) if u not in preload]
    head += [f'<link rel="modulepreload" href="{html.escape(versioned(u, root))}">' for u in preload]
    if boot is not None:
        head.append(f"<script>window.RF_BOOT = {_json(boot)};</script>")
    # right after the charset (it must stay in the first 1024 bytes), before any module script
    anchor = '<meta charset="utf-8">' if '<meta charset="utf-8">' in page else "<head>"
    return page.replace(anchor, anchor + "\n" + "\n".join(head), 1)


def _json(data) -> str:
    # safe inside <script>: no "</script>" or "<!--" can appear
    return json.dumps(data, separators=(",", ":")).replace("<", "\\u003c")
