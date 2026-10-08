import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import HDR
from remote_finder.config import CSRF_HEADER
from remote_finder.main import app


def test_bad_host_rejected():
    c = TestClient(app, base_url="http://evil.example")
    assert c.get("/api/home").status_code == 400
    c = TestClient(app, base_url="http://localhost.evil.example:8090")
    assert c.get("/api/home").status_code == 400


@pytest.mark.parametrize("host", ["localhost", "localhost:9000", "127.0.0.1:8090", "[::1]:8090"])
def test_loopback_hosts_ok(host):
    c = TestClient(app, base_url=f"http://{host}")
    assert c.get("/api/home").status_code == 200


def test_mutation_needs_header(client, tmp_path):
    r = client.post("/api/mkdir", json={"dir": str(tmp_path)})
    assert r.status_code == 403
    r = client.post("/api/mkdir", json={"dir": str(tmp_path)}, headers={CSRF_HEADER: "1", "Origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.post("/api/mkdir", json={"dir": str(tmp_path)}, headers=HDR)
    assert r.status_code == 200


def test_websocket_origin(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("ws://localhost/ws/terminal", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_text()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("ws://localhost/ws/terminal") as ws:  # no Origin
            ws.receive_text()


def test_active_content_sandboxed(client, tmp_path):
    (tmp_path / "x.html").write_text("<script>alert(1)</script>")
    (tmp_path / "x.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    (tmp_path / "x.pdf").write_bytes(b"%PDF-1.4")
    r = client.get("/api/raw", params={"path": str(tmp_path / "x.html")})
    assert r.headers["content-type"].startswith("text/plain") and r.headers["content-security-policy"] == "sandbox"
    assert r.headers["x-content-type-options"] == "nosniff"
    r = client.get("/api/raw", params={"path": str(tmp_path / "x.html"), "render": 1})
    assert r.headers["content-type"].startswith("text/html") and r.headers["content-security-policy"] == "sandbox allow-scripts"
    r = client.get("/api/raw", params={"path": str(tmp_path / "x.svg")})
    assert r.headers["content-type"].startswith("text/plain")
    r = client.get("/api/raw", params={"path": str(tmp_path / "x.pdf")})
    assert r.headers["content-type"] == "application/pdf"
