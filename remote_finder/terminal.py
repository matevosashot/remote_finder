"""Browser terminal: a login shell on a pty, bridged over a WebSocket.

Client -> server: JSON text frames
    {"t": "i", "d": "<input>"}            keystrokes
    {"t": "r", "c": cols, "r": rows}      resize
    {"t": "cd", "p": "/some/dir"}         cd there if the shell is idle
Server -> client: binary frames with pty output, JSON text frames for events
    {"t": "busy"} | {"t": "cd", "p": ...} | {"t": "exit", "code": n}
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pwd
import shlex
import signal
import struct
import subprocess
import termios

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


def _shell() -> str:
    try:
        sh = pwd.getpwuid(os.getuid()).pw_shell
    except KeyError:
        sh = ""
    return sh if sh and os.path.exists(sh) else os.environ.get("SHELL", "/bin/bash")


def _set_size(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(rows, 2), max(cols, 2), 0, 0))


def _spawn(cwd: str, cols: int, rows: int) -> tuple[subprocess.Popen, int]:
    """Start the user's login shell (so ~/.profile PATH additions apply) on a new pty."""
    master, slave = os.openpty()
    _set_size(master, cols, rows)
    shell = _shell()
    env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "SHELL": shell}
    for k in ("INVOCATION_ID", "JOURNAL_STREAM"):  # systemd service leftovers
        env.pop(k, None)

    def child_setup() -> None:
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen([shell, "-l"], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
                            preexec_fn=child_setup, close_fds=True)
    os.close(slave)
    os.set_blocking(master, False)
    return proc, master


def _reap(proc: subprocess.Popen) -> None:
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()


@router.websocket("/ws/terminal")
async def terminal(ws: WebSocket, cwd: str = "~", cols: int = 120, rows: int = 30) -> None:
    await ws.accept()
    cwd = os.path.expanduser(cwd)
    if not os.path.isdir(cwd):
        cwd = os.path.expanduser("~")
    proc, master = _spawn(cwd, cols, rows)
    loop = asyncio.get_running_loop()

    # pty -> browser: the reader callback queues output; pump_out coalesces bursts into one frame
    out_q: asyncio.Queue[bytes | None] = asyncio.Queue()

    def on_readable() -> None:
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO: shell exited
            data = b""
        if not data:
            loop.remove_reader(master)
            out_q.put_nowait(None)
        else:
            out_q.put_nowait(data)

    async def pump_out() -> None:
        while True:
            data = await out_q.get()
            if data is None:
                code = await asyncio.to_thread(proc.wait)
                await ws.send_text(json.dumps({"t": "exit", "code": code}))
                await ws.close()
                return
            while not out_q.empty():
                nxt = out_q.get_nowait()
                if nxt is None:
                    out_q.put_nowait(None)
                    break
                data += nxt
            await ws.send_bytes(data)

    # browser -> pty: buffered and written when the pty is writable, so a big paste into a
    # busy terminal never blocks the event loop (and with it every other request)
    pending = bytearray()

    def flush_input() -> None:
        try:
            del pending[:os.write(master, pending)]
        except BlockingIOError:
            pass
        except OSError:
            pending.clear()
        if not pending:
            loop.remove_writer(master)

    def write(data: bytes) -> None:
        was_idle = not pending
        pending.extend(data)
        if was_idle:
            flush_input()
            if pending:
                loop.add_writer(master, flush_input)

    def shell_idle() -> bool:
        try:
            return os.tcgetpgrp(master) == proc.pid  # no foreground job besides the shell
        except OSError:
            return False

    loop.add_reader(master, on_readable)
    out_task = asyncio.create_task(pump_out())
    try:
        while True:
            m = json.loads(await ws.receive_text())
            t = m.get("t")
            if t == "i":
                write(m.get("d", "").encode())
            elif t == "r":
                _set_size(master, int(m.get("c", 80)), int(m.get("r", 24)))
            elif t == "cd":
                path = m.get("p", "")
                if not shell_idle():
                    await ws.send_text(json.dumps({"t": "busy"}))
                elif os.path.isdir(path):
                    # Ctrl-U clears any half-typed line; leading space keeps it out of history
                    write(b"\x15 cd -- " + shlex.quote(path).encode() + b"\r")
                    await ws.send_text(json.dumps({"t": "cd", "p": path}))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        out_task.cancel()
        loop.remove_reader(master)
        loop.remove_writer(master)
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
        try:
            os.close(master)
        except OSError:
            pass
        loop.run_in_executor(None, _reap, proc)
