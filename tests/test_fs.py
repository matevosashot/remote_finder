import os
import zipfile
import io

from conftest import HDR, wait_job


def test_list(client, tree):
    r = client.get("/api/list", params={"path": str(tree)})
    assert r.status_code == 200
    data = r.json()
    by = {e["name"]: e for e in data["entries"]}
    assert by["sub"]["kind"] == "dir"
    assert by["a.txt"]["size"] == 6 and by["a.txt"]["text"]
    assert by[".hidden"]["hidden"]
    assert by["link"]["link"] and by["link"]["target"] == "a.txt" and by["link"]["kind"] == "file"
    assert by["broken"]["broken"]
    assert isinstance(data["mtime_ns"], str)  # JS can't hold ns integers exactly


def test_list_errors(client, tree):
    assert client.get("/api/list", params={"path": "relative"}).status_code == 400
    assert client.get("/api/list", params={"path": str(tree / "missing")}).status_code == 404
    assert client.get("/api/list", params={"path": str(tree / "a.txt")}).status_code == 400
    locked = tree / "locked"
    locked.mkdir()
    os.chmod(locked, 0)
    try:
        if os.geteuid() != 0:
            assert client.get("/api/list", params={"path": str(locked)}).status_code == 403
    finally:
        os.chmod(locked, 0o755)


def test_stat(client, tree):
    st = client.get("/api/stat", params={"path": str(tree / "link")}).json()
    assert st["link"] and st["resolved"].endswith("a.txt")
    assert st["perm"].startswith("-") and len(st["octal"]) == 4
    broken = client.get("/api/stat", params={"path": str(tree / "broken")}).json()
    assert broken["broken"] and broken["kind"] == "link" and broken["target"] == "nope" and "resolved" not in broken
    d = client.get("/api/stat", params={"path": str(tree / "sub")}).json()
    assert d["kind"] == "dir" and d["name"] == "sub" and d["writable"]


def test_raw_and_range(client, tree):
    r = client.get("/api/raw", params={"path": str(tree / "a.txt")})
    assert r.text == "alpha\n"
    r = client.get("/api/raw", params={"path": str(tree / "a.txt")}, headers={"Range": "bytes=1-3"})
    assert r.status_code == 206 and r.text == "lph"
    r = client.get("/api/raw", params={"path": str(tree / "a.txt"), "download": 1})
    assert "attachment" in r.headers["content-disposition"]


def test_download_zip_stream(client, tree):
    r = client.get("/api/download", params={"paths": [str(tree / "sub"), str(tree / "a.txt")]})
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert "a.txt" in names and any(n.startswith("sub/") for n in names)


def test_mkdir_rename_delete(client, tree):
    r = client.post("/api/mkdir", json={"dir": str(tree)}, headers=HDR)
    p1 = r.json()["path"]
    assert p1.endswith("untitled folder") and os.path.isdir(p1)
    p2 = client.post("/api/mkdir", json={"dir": str(tree)}, headers=HDR).json()["path"]
    assert p2.endswith("untitled folder 2")
    r = client.post("/api/rename", json={"path": p2, "name": "renamed"}, headers=HDR)
    assert r.json()["path"] == str(tree / "renamed")
    assert client.post("/api/rename", json={"path": p1, "name": "renamed"}, headers=HDR).status_code == 409
    assert client.post("/api/rename", json={"path": p1, "name": "a/b"}, headers=HDR).status_code == 400
    j = wait_job(client, client.post("/api/delete", json={"paths": [p1, str(tree / "renamed")]}, headers=HDR).json())
    assert j["status"] == "done"
    assert not os.path.exists(p1)
    assert client.post("/api/delete", json={"paths": ["/"]}, headers=HDR).status_code == 400


def test_delete_symlink_to_dir_keeps_target(client, tree):
    os.symlink("sub", tree / "sublink")
    wait_job(client, client.post("/api/delete", json={"paths": [str(tree / "sublink")]}, headers=HDR).json())
    assert not os.path.lexists(tree / "sublink") and (tree / "sub" / "c.md").exists()


def test_transfer_conflicts(client, tree):
    dest = tree / "dest"
    dest.mkdir()
    (dest / "a.txt").write_text("old")
    assert client.post("/api/conflicts", json={"dest": str(dest), "names": ["a.txt", "b.py"]}, headers=HDR).json() == {"conflicts": ["a.txt"]}
    j = wait_job(client, client.post("/api/transfer", json={"op": "copy", "sources": [str(tree / "a.txt"), str(tree / "b.py")],
                                                               "dest": str(dest), "conflict": "keep"}, headers=HDR).json())
    assert j["status"] == "done"
    assert (dest / "a.txt").read_text() == "old" and (dest / "a 2.txt").read_text() == "alpha\n" and (dest / "b.py").exists()
    j = wait_job(client, client.post("/api/transfer", json={"op": "copy", "sources": [str(tree / "a.txt")], "dest": str(dest),
                                                               "decisions": {"a.txt": "replace"}}, headers=HDR).json())
    assert (dest / "a.txt").read_text() == "alpha\n"
    j = wait_job(client, client.post("/api/transfer", json={"op": "move", "sources": [str(tree / "sub")], "dest": str(dest)}, headers=HDR).json())
    assert j["status"] == "done" and (dest / "sub" / "c.md").exists() and not (tree / "sub").exists()
    r = client.post("/api/transfer", json={"op": "move", "sources": [str(dest)], "dest": str(dest / "sub")}, headers=HDR)
    assert r.status_code == 400  # into itself


def test_upload(client, tree):
    r = client.post("/api/upload", params={"dir": str(tree), "relpath": "up/deep/x.bin"}, content=b"\x00\x01" * 1000, headers=HDR)
    assert r.status_code == 200
    assert (tree / "up" / "deep" / "x.bin").read_bytes() == b"\x00\x01" * 1000
    r = client.post("/api/upload", params={"dir": str(tree), "relpath": "a.txt", "conflict": "keep"}, content=b"new", headers=HDR)
    assert r.json()["path"].endswith("a 2.txt")
    r = client.post("/api/upload", params={"dir": str(tree), "relpath": "a.txt", "conflict": "skip"}, content=b"zzz", headers=HDR)
    assert r.json()["skipped"] and (tree / "a.txt").read_text() == "alpha\n"
    assert client.post("/api/upload", params={"dir": str(tree), "relpath": "../escape"}, content=b"x", headers=HDR).status_code == 400
    assert not [p for p in os.listdir(tree) if p.endswith(".part")]


def test_save_checks_mtime(client, tree):
    p = str(tree / "b.py")
    os.chmod(p, 0o750)
    st = client.get("/api/stat", params={"path": p}).json()
    r = client.post("/api/save", json={"path": p, "content": "x = 1\n", "mtime_ns": st["mtime_ns"]}, headers=HDR)
    assert r.status_code == 200 and (tree / "b.py").read_text() == "x = 1\n"
    assert oct(os.stat(p).st_mode & 0o777) == "0o750"  # permissions kept
    r = client.post("/api/save", json={"path": p, "content": "stale", "mtime_ns": st["mtime_ns"]}, headers=HDR)
    assert r.status_code == 409
    r = client.post("/api/save", json={"path": p, "content": "forced", "mtime_ns": st["mtime_ns"], "force": True}, headers=HDR)
    assert r.status_code == 200 and (tree / "b.py").read_text() == "forced"


def test_thumb(client, tmp_path):
    from PIL import Image
    Image.new("RGB", (640, 480), (200, 10, 10)).save(tmp_path / "x.jpg")
    r = client.get("/api/thumb", params={"path": str(tmp_path / "x.jpg"), "size": 128})
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    im = Image.open(io.BytesIO(r.content))
    assert max(im.size) == 128


def test_search_and_walk(client, tree):
    r = client.get("/api/search", params={"root": str(tree), "q": "c.m"})
    import json
    lines = [json.loads(l) for l in r.text.splitlines()]
    hits = [l for l in lines if "path" in l]
    assert [h["path"] for h in hits] == [str(tree / "sub" / "c.md")] and hits[0]["kind"] == "file"
    assert lines[-1]["done"]
    r = client.get("/api/search", params={"root": str(tree), "q": "*.py"})
    assert any(json.loads(l).get("name") == "b.py" for l in r.text.splitlines())
    w = client.get("/api/walk", params={"root": str(tree)}).json()
    assert "sub/" in w["paths"] and "sub/c.md" in w["paths"] and ".hidden" not in w["paths"]


def test_settings_roundtrip(client):
    assert client.get("/api/settings").json()["view"] == "list"
    client.put("/api/settings", json={"view": "icons", "bookmarks": ["/tmp"]}, headers=HDR)
    s = client.get("/api/settings").json()
    assert s["view"] == "icons" and s["bookmarks"] == ["/tmp"]


def test_du(client, tree):
    os.link(tree / "a.txt", tree / "hardlink")
    j = wait_job(client, client.post("/api/du", json={"path": str(tree)}, headers=HDR).json())
    assert j["status"] == "done"
    # a.txt counted once despite the hardlink; symlinks count their own (tiny) size
    assert j["result"]["files"] >= 4


def test_job_endpoints_validate_body(client):
    for url in ("/api/du", "/api/extract", "/api/delete"):
        assert client.post(url, json={}, headers=HDR).status_code == 422
    assert client.post("/api/delete", json={"paths": ["/"]}, headers=HDR).status_code == 400
    assert client.post("/api/transfer", json={"op": "copy", "sources": ["/tmp"], "dest": "/tmp/x"},
                       headers=HDR).status_code == 400
