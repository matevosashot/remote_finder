import os

import pytest

from remote_finder import text_api

N = 300_000


@pytest.fixture(scope="module")
def big(tmp_path_factory):
    p = tmp_path_factory.mktemp("big") / "big.log"
    with open(p, "w") as f:
        for i in range(1, N + 1):
            f.write(f"line {i} {'ERR' if i % 997 == 0 else 'ok'}\n")
    return p


def get(client, path, **kw):
    r = client.get("/api/text", params={"path": str(path), **kw})
    assert r.status_code == 200, r.text
    return r.json()


def texts(res):
    return [l["t"] for l in res["lines"]]


def test_head_tail(client, big):
    assert texts(get(client, big, mode="head", n=3)) == ["line 1 ok", "line 2 ok", "line 3 ok"]
    res = get(client, big, mode="tail", n=3)
    assert texts(res) == [f"line {N-2} ok", f"line {N-1} ok", f"line {N} ok"]
    assert res["lines"][0]["o"] == os.path.getsize(big) - sum(len(t) + 1 for t in texts(res))


def test_line_and_byte(client, big):
    res = get(client, big, mode="line", start=250_001, n=2)
    assert [l["n"] for l in res["lines"]] == [250_001, 250_002] and res["lines"][0]["t"].startswith("line 250001 ")
    res2 = get(client, big, mode="line", start=12_345, n=1)  # cached index, other checkpoint
    assert res2["lines"][0]["t"].startswith("line 12345 ")
    first = get(client, big, mode="head", n=10)
    off = first["lines"][5]["o"]
    assert texts(get(client, big, mode="byte", start=off, n=1)) == ["line 6 ok"]
    assert texts(get(client, big, mode="byte", start=off + 2, n=1)) == ["line 7 ok"]  # mid-line aligns forward
    assert get(client, big, mode="head", n=2)["next"] == first["lines"][2]["o"]


def test_grep(client, big):
    res = get(client, big, mode="head", n=3, grep="ERR")
    assert [l["n"] for l in res["lines"]] == [997, 1994, 2991]
    res = get(client, big, mode="tail", n=1, grep="err", icase=True)
    last = (N // 997) * 997
    assert texts(res) == [f"line {last} ERR"]
    assert client.get("/api/text", params={"path": str(big), "grep": "("}).status_code == 400


@pytest.mark.parametrize("content,expected", [
    (b"", []),
    (b"no newline", ["no newline"]),
    (b"a\r\nb\r\n", ["a", "b"]),
    (b"\n\n", ["", ""]),
    (b"x\ny", ["x", "y"]),
])
def test_edge_files(client, tmp_path, content, expected):
    p = tmp_path / "f.txt"
    p.write_bytes(content)
    assert texts(get(client, p, mode="head", n=10)) == expected
    assert texts(get(client, p, mode="tail", n=10)) == expected
    assert texts(get(client, p, mode="tail", n=1)) == expected[-1:]


def test_giant_line_is_cut(client, tmp_path):
    p = tmp_path / "minified.json"
    p.write_bytes(b"[" + b"1," * (25 << 20) + b"1]\nsecond\n")  # one 50 MB line
    res = get(client, p, mode="head", n=2)
    assert res["lines"][0]["cut"] and len(res["lines"][0]["t"]) == text_api.MAX_LINE
    assert res["lines"][1]["t"] == "second"
    res = get(client, p, mode="tail", n=2)
    assert res["lines"][0]["cut"] and res["lines"][1]["t"] == "second"
    # a byte offset inside the giant line aligns forward to the next line
    assert texts(get(client, p, mode="byte", start=1000, n=1)) == ["second"]


def test_binary_flag(client, tmp_path):
    p = tmp_path / "bin"
    p.write_bytes(b"\x00\x01\x02hello\n")
    assert get(client, p, mode="head", n=1)["binary"]


def test_follow(client, tmp_path):
    p = tmp_path / "grow.log"
    p.write_text("start\n")
    with client.websocket_connect(f"ws://localhost/ws/follow?path={p}", headers={"Origin": "http://localhost"}) as ws:
        with open(p, "a") as f:
            f.write("one\ntwo\npart")
        msg = ws.receive_json()
        assert msg == {"type": "lines", "lines": ["one", "two"], "end": os.path.getsize(p)}
        with open(p, "a") as f:
            f.write("ial\n")
        assert ws.receive_json()["lines"] == ["partial"]
        p.write_text("")  # truncate
        assert ws.receive_json() == {"type": "reset", "reason": "truncated"}
        with open(p, "a") as f:
            f.write("after\n")
        assert ws.receive_json()["lines"] == ["after"]
