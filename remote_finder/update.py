"""Update check against the GitHub repo, and a one-click upgrade.

The check runs only when a page asks (GET /api/update, called when the main window opens) and at
most once a day: the answer is cached in ~/.cache/remote-finder/update.json. The upgrade re-runs
pip for this install, then the server restarts itself with the same flags.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import site
import subprocess
import sys
import threading
import time
import urllib.request

from fastapi import APIRouter, HTTPException

from .config import CACHE_DIR

router = APIRouter(prefix="/api")

REPO = "matevosashot/remote_finder"
GIT_URL = f"https://github.com/{REPO}.git"
CACHE = os.path.join(CACHE_DIR, "update.json")
DAY = 24 * 3600
PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_lock = threading.Lock()

# set by serve.serve(): the command line flags to restart with after an upgrade
launch_args: list[str] | None = None


def installed() -> dict | None:
    """{"commit", "kind": "pip"|"checkout", "user": bool} for this copy, or None if unknown."""
    try:
        dist = importlib.metadata.distribution("remote-finder")
        info = json.loads(dist.read_text("direct_url.json") or "null")
        here = os.path.realpath(str(dist.locate_file("remote_finder"))) == os.path.realpath(PKG_DIR)
    except (importlib.metadata.PackageNotFoundError, ValueError):
        info, here, dist = None, False, None
    commit = (info or {}).get("vcs_info", {}).get("commit_id")
    if here and commit and REPO in (info or {}).get("url", ""):
        user_site = os.path.realpath(site.getusersitepackages())
        return {"commit": commit, "kind": "pip",
                "user": os.path.realpath(str(dist.locate_file(""))).startswith(user_site)}
    repo = os.path.dirname(PKG_DIR)
    if os.path.isdir(os.path.join(repo, ".git")):
        r = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True)
        if r.returncode == 0:
            return {"commit": r.stdout.strip(), "kind": "checkout", "user": False, "repo": repo}
    return None


def fetch_compare(base: str) -> dict:
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/compare/{base}...main",
                                 headers={"Accept": "application/vnd.github+json", "User-Agent": "remote-finder"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def _load() -> dict | None:
    try:
        with open(CACHE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, CACHE)


def status(now: float | None = None) -> dict:
    now = time.time() if now is None else now
    cur = installed()
    if not cur:
        return {"enabled": False}
    with _lock:  # several tabs opening at once make one request
        cached = _load()
        if cached and cached.get("current") == cur["commit"] and now - cached.get("checked_at", 0) < DAY:
            return {**cached, "kind": cur["kind"]}
        result = {"enabled": True, "current": cur["commit"], "checked_at": now, "behind": 0, "latest": cur["commit"], "commits": []}
        try:
            data = fetch_compare(cur["commit"])
            commits = data.get("commits") or []
            result["behind"] = int(data.get("ahead_by", 0))
            if result["behind"] and commits:
                result["latest"] = commits[-1]["sha"]
                result["commits"] = [{"sha": c["sha"][:7], "message": c["commit"]["message"].split("\n")[0]}
                                     for c in commits[-30:]]
        except Exception as e:  # offline, rate-limited, or a commit GitHub doesn't know: ask again tomorrow
            result["error"] = str(e)
        _save(result)
    return {**result, "kind": cur["kind"]}


@router.get("/update")
def get_update() -> dict:
    return status()


def pip_commands(cur: dict) -> list[list[str]]:
    """Reinstall this package from main, then add any dependencies it gained.

    Every commit has the same version number, so a plain `pip install --upgrade` would see nothing to do:
    the package itself is force-reinstalled (alone, so its dependencies aren't reinstalled too).
    """
    base = [sys.executable, "-m", "pip", "install", "--quiet", *(["--user"] if cur.get("user") else [])]
    url = f"git+{GIT_URL}@main"
    return [[*base, "--force-reinstall", "--no-deps", url], [*base, url]]


def restart() -> None:
    os.execv(sys.executable, [sys.executable, "-m", "remote_finder", *launch_args])


@router.post("/update/install")
def install() -> dict:
    cur = installed()
    if not cur or cur["kind"] != "pip":
        raise HTTPException(400, "This copy runs from a git checkout; update it with git pull")
    for cmd in pip_commands(cur):
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise HTTPException(500, f"pip failed:\n{(r.stderr or r.stdout).strip()[-2000:]}")
    try:
        os.remove(CACHE)  # the next page load checks the new version
    except OSError:
        pass
    if launch_args is None:
        return {"restarting": False}
    threading.Timer(1.0, restart).start()  # after this response has gone out
    return {"restarting": True}
