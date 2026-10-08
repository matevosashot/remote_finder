import json
import time


def read_until(ws, needle, timeout=10):
    buf = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = ws.receive()
        if msg.get("bytes"):
            buf += msg["bytes"]
            if needle.encode() in buf:
                return buf.decode(errors="replace")
        elif msg.get("text"):
            evt = json.loads(msg["text"])
            if evt.get("t") == "busy" and needle == "BUSY":
                return "BUSY"
    raise AssertionError(f"{needle!r} not seen; got {buf[-500:]!r}")


def test_terminal_cwd_and_cd(client, tmp_path):
    (tmp_path / "sub dir").mkdir()
    with client.websocket_connect(f"ws://localhost/ws/terminal?cwd={tmp_path}", headers={"Origin": "http://localhost"}) as ws:
        ws.send_text(json.dumps({"t": "r", "c": 100, "r": 30}))
        ws.send_text(json.dumps({"t": "i", "d": "echo CWD=$(pwd)\r"}))
        out = read_until(ws, f"CWD={tmp_path}")
        assert f"CWD={tmp_path}" in out
        time.sleep(0.3)
        ws.send_text(json.dumps({"t": "cd", "p": str(tmp_path / "sub dir")}))
        time.sleep(0.5)
        ws.send_text(json.dumps({"t": "i", "d": "echo NOW=$(pwd)\r"}))
        read_until(ws, f"NOW={tmp_path}/sub dir")
        # busy: a foreground program is running -> cd refused
        ws.send_text(json.dumps({"t": "i", "d": "sleep 3\r"}))
        time.sleep(0.5)
        ws.send_text(json.dumps({"t": "cd", "p": str(tmp_path)}))
        assert read_until(ws, "BUSY") == "BUSY"


def test_big_paste_into_busy_terminal_does_not_block(client, tmp_path):
    """Input the pty can't take yet is buffered, so the server keeps answering meanwhile."""
    with client.websocket_connect(f"ws://localhost/ws/terminal?cwd={tmp_path}", headers={"Origin": "http://localhost"}) as ws:
        ws.send_text(json.dumps({"t": "i", "d": "stty raw -echo; sleep 4; stty sane\r"}))  # like vim: raw, not reading
        time.sleep(0.8)
        ws.send_text(json.dumps({"t": "i", "d": "x" * 300_000}))  # far more than the tty buffer holds
        t0 = time.time()
        ws.send_text(json.dumps({"t": "cd", "p": str(tmp_path)}))
        assert read_until(ws, "BUSY") == "BUSY"
        assert time.time() - t0 < 2, "event loop was blocked by the pending write"
