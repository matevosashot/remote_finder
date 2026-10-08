"""Names and locations shared across the app."""

from __future__ import annotations

import os

APP_NAME = "Remote Finder"
SLUG = "remote-finder"

CONFIG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), SLUG)
CACHE_DIR = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), SLUG)

# Every state-changing request must carry `CSRF_HEADER: 1` (see security.py).
CSRF_HEADER = "X-Remote-Finder"
