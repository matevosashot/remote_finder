"""Install or remove a systemd service that runs Remote Finder on boot.

The unit runs the same Python that is running this command (so it works from a venv, pipx or
`pip install --user`) as `python -m remote_finder --socket PATH` or `--port N`. A system-wide unit
runs as you (the user who ran sudo), never as root: the app can see and change whatever its user can.
"""

from __future__ import annotations

import os
import pwd
import re
import subprocess
import sys

from .config import SLUG
from .serve import DEFAULT_SOCKET, tunnel_hint

UNIT = f"{SLUG}.service"


def run(cmd: list[str], *, input: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, input=input, text=True, check=check, stdout=None if input is None else subprocess.DEVNULL)


def quote(arg: str) -> str:
    """One word of an ExecStart= line (systemd's own quoting; `%` and `$` are special there)."""
    arg = arg.replace("%", "%%").replace("$", "$$")
    return arg if re.fullmatch(r"[A-Za-z0-9_@%:,./=+-]+", arg) else '"' + arg.replace("\\", "\\\\").replace('"', '\\"') + '"'


def run_as_user(scope: str) -> pwd.struct_passwd:
    """The account the service runs as: you, or whoever ran sudo."""
    entry = pwd.getpwuid(os.getuid())
    if scope == "system" and entry.pw_uid == 0:
        sudo_user = os.environ.get("SUDO_USER")
        if not sudo_user or sudo_user == "root":
            sys.exit("Refusing to run the service as root (it includes a shell and a file manager). "
                     "Run this as your own user; it uses sudo where it needs to.")
        entry = pwd.getpwnam(sudo_user)
    return entry


def socket_for(user: pwd.struct_passwd, socket_path: str | None) -> str:
    if socket_path and socket_path != DEFAULT_SOCKET:
        return os.path.abspath(os.path.expanduser(socket_path))
    if user.pw_uid == os.getuid():
        return DEFAULT_SOCKET
    return os.path.join(user.pw_dir, ".cache", SLUG, "app.sock")


def unit_path(scope: str) -> str:
    if scope == "system":
        return f"/etc/systemd/system/{UNIT}"
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "systemd", "user", UNIT)


def unit_text(scope: str, user: str, listen: list[str]) -> str:
    exec_start = " ".join(quote(a) for a in [sys.executable, "-m", "remote_finder", *listen])
    lines = ["[Unit]", "Description=Remote Finder (Finder-style web file manager)"]
    if scope == "system":
        lines.append("After=network.target")
    lines += ["", "[Service]"]
    if scope == "system":
        lines += [f"User={user}", "WorkingDirectory=~"]
    lines += [f"ExecStart={exec_start}", "Restart=on-failure", "RestartSec=2", "",
              "[Install]", f"WantedBy={'multi-user.target' if scope == 'system' else 'default.target'}", ""]
    return "\n".join(lines)


def _sudo(scope: str) -> list[str]:
    return ["sudo"] if scope == "system" and os.geteuid() != 0 else []


def install(scope: str, socket_path: str | None = None, port: int | None = None) -> None:
    user = run_as_user(scope)
    if port:
        listen, path = ["--port", str(port)], None
    else:
        path = socket_for(user, socket_path)
        listen = ["--socket", path]
    target = unit_path(scope)
    text = unit_text(scope, user.pw_name, listen)
    sudo = _sudo(scope)
    ctl = ["systemctl", "--user"] if scope == "user" else [*sudo, "systemctl"]

    if scope == "user":
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w") as f:
            f.write(text)
    else:
        if sudo:
            run([*sudo, "tee", target], input=text)
        else:
            with open(target, "w") as f:
                f.write(text)
    run([*ctl, "daemon-reload"])
    run([*ctl, "enable", UNIT])
    run([*ctl, "restart", UNIT])
    if scope == "user":
        if run(["loginctl", "enable-linger", user.pw_name], check=False).returncode != 0:
            print(f"Could not enable lingering, so the service only runs while you are logged in.\n"
                  f"To start it at boot, run: sudo loginctl enable-linger {user.pw_name}", file=sys.stderr)

    flag = "--user " if scope == "user" else ""
    print(f"Installed {target} ({scope} service, runs as {user.pw_name})")
    print(f"  status: {' '.join(ctl)} status {UNIT}")
    print(f"  logs:   journalctl {flag}-u {UNIT} -f")
    print(tunnel_hint(path, user.pw_name) if path else "Listening on 127.0.0.1:%d (open to every account on this machine)" % port)


def uninstall(scope: str) -> None:
    target = unit_path(scope)
    sudo = _sudo(scope)
    ctl = ["systemctl", "--user"] if scope == "user" else [*sudo, "systemctl"]
    run([*ctl, "disable", "--now", UNIT], check=False)
    if os.path.exists(target):
        if scope == "user":
            os.remove(target)
        else:
            run([*sudo, "rm", "-f", target])
    run([*ctl, "daemon-reload"], check=False)
    print(f"Removed {target}")
