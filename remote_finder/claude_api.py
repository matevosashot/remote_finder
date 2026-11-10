"""Launch Claude Code in a folder: a new window in the tmux session "claude", with Remote Control on."""

from __future__ import annotations

import os
import pwd
import re
import shlex
import shutil
import subprocess

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .fsutil import norm

router = APIRouter(prefix="/api")
SESSION = "claude"


class ClaudeBody(BaseModel):
    cwd: str


def window_name(cwd: str) -> str:
    """The folder's name, without the characters tmux treats as target syntax."""
    return re.sub(r"[.:\s]+", "-", os.path.basename(cwd)).strip("-") or "root"


def shell_command(name: str) -> str:
    # a login, interactive shell, so PATH (~/.local/bin) is the user's even when the app runs under systemd;
    # when claude exits, the window stays open on a shell in the same folder
    shell = pwd.getpwuid(os.getuid()).pw_shell or os.environ.get("SHELL") or "/bin/bash"
    script = f"claude --remote-control {shlex.quote(name)}; exec {shlex.quote(shell)} -l"
    return shlex.join([shell, "-lic", script])


@router.post("/claude")
def launch(body: ClaudeBody) -> dict:
    cwd = norm(body.cwd)
    if not os.path.isdir(cwd):
        raise HTTPException(400, "not a folder")
    tmux = shutil.which("tmux")
    if not tmux:
        raise HTTPException(503, "tmux is not installed on this machine")
    name = window_name(cwd)
    exact = f"={SESSION}"  # "=": exact name; plain "claude" would also match "claude-2"
    exists = subprocess.run([tmux, "has-session", "-t", exact], capture_output=True).returncode == 0
    where = ["new-window", "-t", f"{exact}:"] if exists else ["new-session", "-d", "-s", SESSION]
    r = subprocess.run([tmux, *where, "-c", cwd, "-n", name, "-P", "-F", "#{window_id}", shell_command(name)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise HTTPException(500, f"tmux: {r.stderr.strip() or r.returncode}")
    return {"session": SESSION, "window_id": r.stdout.strip(), "name": name}
