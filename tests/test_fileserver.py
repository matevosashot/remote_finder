import socket
import time
import urllib.error
import urllib.request

import pytest

from conftest import HDR
from remote_finder import fileserver


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def fetch(url: str, **headers) -> tuple[int, dict, bytes]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=5) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


@pytest.fixture
def site(tmp_path):
    (tmp_path / "media").mkdir()
    (tmp_path / "media" / "clip.bin").write_bytes(bytes(range(256)) * 4)
    (tmp_path / "index.html").write_text("<h1>hi</h1>")
    return tmp_path


@pytest.fixture(autouse=True)
def stop_all():
    yield
    for fs in list(fileserver._servers.values()):
        fileserver.stop(fs, "test over")


def start(client, path, **body):
    r = client.post("/api/fileservers", json={"path": str(path), "port": free_port(), "host": "127.0.0.1", **body},
                    headers=HDR)
    assert r.status_code == 200, r.text
    return r.json()


def test_serves_files_ranges_and_listings(client, site):
    s = start(client, site, open="index.html")
    base = f"http://127.0.0.1:{s['port']}"
    assert s["urls"][0]["url"] == f"http://localhost:{s['port']}/index.html"
    assert s["tunnel"].startswith(f"ssh -N -L {s['port']}:localhost:{s['port']} ")
    status, headers, body = fetch(f"{base}/index.html")
    assert (status, body) == (200, b"<h1>hi</h1>") and headers["Cache-Control"] == "no-cache"
    status, headers, body = fetch(f"{base}/media/clip.bin", Range="bytes=10-19")
    assert status == 206 and body == bytes(range(10, 20)) and headers["Content-Range"] == "bytes 10-19/1024"
    status, _, body = fetch(f"{base}/media/clip.bin", Range="bytes=-4")
    assert status == 206 and body == bytes(range(252, 256))
    status, headers, _ = fetch(f"{base}/media/clip.bin", Range="bytes=5000-")
    assert status == 416 and headers["Content-Range"] == "bytes */1024"
    status, _, body = fetch(f"{base}/media/")
    assert status == 200 and b"clip.bin" in body
    assert "Access-Control-Allow-Origin" not in fetch(f"{base}/index.html")[1]

    log = client.get(f"/api/fileservers/{s['id']}/log").json()
    assert [x["status"] for x in log["lines"]] == [200, 206, 206, 416, 200, 200]
    assert log["server"]["requests"] == 6 and log["server"]["bytes"] > 11 + 10 + 4
    assert client.get(f"/api/fileservers/{s['id']}/log", params={"after": 5}).json()["lines"][0]["n"] == 6


def test_cors_busy_port_and_stop(client, site):
    s = start(client, site, cors=True)
    assert fetch(f"http://127.0.0.1:{s['port']}/index.html")[1]["Access-Control-Allow-Origin"] == "*"
    r = client.post("/api/fileservers", json={"path": str(site), "port": s["port"], "host": "127.0.0.1"}, headers=HDR)
    other = r.json()
    assert other["port"] == s["port"] + 1 or other["port"] > s["port"]
    assert other["note"].startswith(f"Port {s['port']} is in use")
    assert {x["id"] for x in client.get("/api/fileservers").json()} == {s["id"], other["id"]}
    assert client.post(f"/api/fileservers/{s['id']}/stop", headers=HDR).json() == {"ok": True}
    with pytest.raises(urllib.error.URLError):
        urllib.request.urlopen(f"http://127.0.0.1:{s['port']}/", timeout=2)
    log = client.get(f"/api/fileservers/{s['id']}/log").json()  # stopped servers keep their log for a while
    assert log["server"]["running"] is False and log["server"]["reason"] == "stopped"
    assert client.post(f"/api/fileservers/{s['id']}/stop", headers=HDR).status_code == 404


def test_validation(client, site):
    body = {"path": str(site / "index.html"), "port": free_port()}
    assert client.post("/api/fileservers", json=body, headers=HDR).status_code == 400  # a file, not a folder
    assert client.post("/api/fileservers", json={**body, "path": str(site)}).status_code == 403  # CSRF header
    assert client.post("/api/fileservers", json={**body, "path": str(site), "host": "8.8.8.8"}, headers=HDR).status_code == 422


def test_stops_when_unused(client, site):
    s = start(client, site, idle_min=1)
    fs = fileserver._servers[s["id"]]
    fileserver.reap(now=fs.last_used + 30)
    assert s["id"] in fileserver._servers
    fileserver.reap(now=fs.last_used + 61)
    assert s["id"] not in fileserver._servers and fs.reason == "unused for 1 min"


def test_stops_when_its_tab_is_gone(client, site):
    with client.websocket_connect("ws://localhost/ws/fileservers?tab=t1", headers={"Origin": "http://localhost"}) as ws:
        s = start(client, site, idle_min=None, tab="t1")
        kept = start(client, site, idle_min=None, tab="t1", stop_with_tab=False)
        for _ in range(5):  # the first message is the list from before; changes follow within a second
            if any(x["id"] == s["id"] for x in ws.receive_json().get("servers", [])):
                break
        else:
            pytest.fail("the socket never listed the new server")
        fileserver.reap(now=time.time() + 3600)  # tab still open
        assert s["id"] in fileserver._servers
    deadline = time.time() + 5
    while fileserver._tabs["t1"]["gone_at"] is None and time.time() < deadline:
        time.sleep(0.05)
    gone_at = fileserver._tabs["t1"]["gone_at"]
    fileserver.reap(now=gone_at + fileserver.GRACE - 1)  # a reload comes back within the grace
    assert s["id"] in fileserver._servers
    fileserver.reap(now=gone_at + fileserver.GRACE + 1)
    assert s["id"] not in fileserver._servers and kept["id"] in fileserver._servers
    assert fileserver._finished[s["id"]].reason == "its Finder tab closed"
