"""Start the server on a Unix socket that only this user can open.

A port on 127.0.0.1 is open to every account on the machine, and another account could take the
port while the app is down. A socket file in a folder with mode 700 is reachable only by its owner
(and root), at the same path every time. Reach it from a laptop with
`ssh -N -L 8090:<socket path> you@server`.

REMOTE_FINDER_SOCKET=<path> picks another socket path; REMOTE_FINDER_PORT=<n> serves on
127.0.0.1:<n> instead, open to every local account.
"""

from __future__ import annotations

import errno
import logging
import os
import socket
import stat
import sys

import uvicorn

from .config import CACHE_DIR

SOCKET_PATH = os.environ.get("REMOTE_FINDER_SOCKET") or os.path.join(CACHE_DIR, "app.sock")
log = logging.getLogger("remote_finder")


def private_dir(path: str) -> None:
    """Create `path` (mode 700) or check that it is ours; make it private either way."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        sys.exit(f"{path} must be a folder owned by you")
    os.chmod(path, 0o700)


def bind_socket(path: str) -> socket.socket:
    """Listen on `path`, replacing a socket left behind by a crash, refusing if one is live."""
    if len(os.fsencode(path)) > 107:   # the kernel's limit for socket paths
        sys.exit(f"{path} is too long for a socket; set REMOTE_FINDER_SOCKET to a shorter path")
    private_dir(os.path.dirname(path))
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        pass
    else:
        if not stat.S_ISSOCK(st.st_mode):
            sys.exit(f"{path} exists and is not a socket; move it away first")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(path)
            sys.exit(f"Remote Finder is already running on {path}")
        except OSError as e:
            if e.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                raise
        finally:
            probe.close()
        os.unlink(path)   # stale: nobody is listening
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)   # the socket is created 600, never briefly open to others
    try:
        sock.bind(path)
    finally:
        os.umask(old)
    sock.listen(2048)
    return sock


def main() -> None:
    port = os.environ.get("REMOTE_FINDER_PORT")
    opts = {"workers": 1, "access_log": False}
    if port:
        print(f"Serving on 127.0.0.1:{port}; every account on this machine can connect", file=sys.stderr)
        uvicorn.run("remote_finder.main:app", host="127.0.0.1", port=int(port), **opts)
        return
    sock = bind_socket(SOCKET_PATH)
    print(f"Serving on {SOCKET_PATH}\nFrom your laptop: ssh -N -L 8090:{SOCKET_PATH} {os.environ.get('USER', 'you')}@"
          f"{socket.gethostname()}  then open http://localhost:8090", file=sys.stderr)
    try:
        uvicorn.run("remote_finder.main:app", fd=sock.fileno(), **opts)
    finally:
        sock.close()
        try:
            os.unlink(SOCKET_PATH)
        except OSError:
            pass


if __name__ == "__main__":
    main()
