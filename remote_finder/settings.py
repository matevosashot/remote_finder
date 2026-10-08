"""Server-side preferences (bookmarks, view options) so they survive across browsers."""

from __future__ import annotations

import json
import os

from fastapi import APIRouter, Body

from .config import CONFIG_DIR

router = APIRouter(prefix="/api")

PATH = os.path.join(CONFIG_DIR, "settings.json")


def _defaults() -> dict:
    home = os.path.expanduser("~")
    return {"bookmarks": [home, "/"], "view": "list", "iconSize": 72, "showHidden": False,
            "sort": {"key": "name", "dir": 1}, "preview": False}


def load() -> dict:
    try:
        with open(PATH) as f:
            return {**_defaults(), **json.load(f)}
    except (OSError, ValueError):
        return _defaults()


@router.get("/settings")
def get_settings() -> dict:
    return load()


@router.put("/settings")
def put_settings(patch: dict = Body(...)) -> dict:
    data = {**load(), **patch}
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    tmp = PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, PATH)
    return data
