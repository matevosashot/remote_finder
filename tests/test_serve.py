"""Serving on a private Unix socket: only this user can connect, stale sockets are reclaimed."""

import http.client
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def sock_dir():
    # socket paths are limited to 107 bytes, so not under pytest's long tmp_path
    d = tempfile.mkdtemp(prefix="rf", dir="/tmp")
    yield d
    shutil.rmtree(d, ignore_errors=True)


def serve(path):
    return subprocess.Popen([sys.executable, "-m", "remote_finder", "--socket", path], cwd=ROOT, env=os.environ,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def get(path, url):
    class Conn(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(path)

    c = Conn("localhost")
    c.request("GET", url, headers={"Host": "localhost:8090"})
    r = c.getresponse()
    return r.status, r.read()


def wait_ready(proc, path):
    for _ in range(100):
        if proc.poll() is not None:
            raise AssertionError(proc.stdout.read())
        try:
            return get(path, "/api/home")
        except OSError:
            time.sleep(0.05)
    raise AssertionError("server did not start")


def stop(proc):
    proc.terminate()
    proc.wait(10)


def test_private_socket(sock_dir):
    path = os.path.join(sock_dir, "run", "app.sock")
    proc = serve(path)
    try:
        status, body = wait_ready(proc, path)
        assert status == 200 and b'"home"' in body
        assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
        assert stat.S_ISSOCK(os.lstat(path).st_mode) and stat.S_IMODE(os.lstat(path).st_mode) == 0o600
        # a second copy can't take over the live socket
        second = serve(path)
        assert second.wait(20) == 1 and "already running" in second.stdout.read()
        assert get(path, "/api/home")[0] == 200
    finally:
        stop(proc)


def test_stale_socket_and_loose_folder(sock_dir):
    path = os.path.join(sock_dir, "app.sock")
    os.chmod(sock_dir, 0o755)
    stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stale.bind(path)   # left behind by a crash: nobody listens
    stale.close()
    proc = serve(path)
    try:
        assert wait_ready(proc, path)[0] == 200
        assert stat.S_IMODE(os.stat(sock_dir).st_mode) == 0o700
    finally:
        stop(proc)


def test_refuses_a_file_in_the_way(sock_dir):
    path = os.path.join(sock_dir, "app.sock")
    with open(path, "w") as f:
        f.write("not a socket")
    proc = serve(path)
    assert proc.wait(20) == 1 and "not a socket" in proc.stdout.read()
    with open(path) as f:
        assert f.read() == "not a socket"


def test_too_long_path_is_explained(sock_dir):
    proc = serve(os.path.join(sock_dir, "x" * 120, "app.sock"))
    assert proc.wait(20) == 1 and "too long" in proc.stdout.read()
