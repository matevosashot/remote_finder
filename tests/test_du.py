"""Disk usage scan: totals against GNU du, live snapshots, mount points, archive list, rescan."""

import os
import subprocess
import time

import pytest

from conftest import HDR
from remote_finder import du_api, du_walk

MB = 1 << 20


@pytest.fixture(autouse=True)
def fresh_scans(monkeypatch, tmp_path_factory):
    monkeypatch.setattr(du_api, "ARCHIVE_PATH", str(tmp_path_factory.mktemp("du") / "archive.json"))
    for scan in list(du_api._scans.values()):
        du_api._forget(scan)
    yield
    for scan in list(du_api._scans.values()):
        du_api._forget(scan)


@pytest.fixture
def inline(monkeypatch):
    """List folders in the scan thread, so tests can patch list_dirs."""
    monkeypatch.setattr(du_api, "WORKERS", 0)


@pytest.fixture
def disk_tree(tmp_path):
    root = tmp_path / "root"
    (root / "big" / "deep" / "deeper").mkdir(parents=True)
    (root / "small").mkdir()
    (root / "empty").mkdir()
    (root / "big" / "a.bin").write_bytes(os.urandom(3 * MB))
    (root / "big" / "deep" / "b.bin").write_bytes(os.urandom(2 * MB))
    (root / "big" / "deep" / "deeper" / "c.txt").write_text("c" * 5000)
    for i in range(30):
        (root / "small" / f"f{i}.txt").write_text("x" * (i * 100 + 1))
    with open(root / "sparse.img", "wb") as f:   # 50 MB apparent, almost nothing on disk
        f.truncate(50 * MB)
    os.link(root / "big" / "a.bin", root / "big" / "deep" / "a-hardlink.bin")   # counted once, like du
    os.symlink(str(root / "big"), root / "link-to-big")
    return root


def du_bytes(path, apparent=False):
    out = subprocess.run(["du", "-sx", "-b" if apparent else "-B1", str(path)], capture_output=True, text=True, check=True)
    return int(out.stdout.split()[0])


def start(client, path, **kw):
    r = client.post("/api/du/scans", json={"path": str(path), **kw}, headers=HDR)
    assert r.status_code == 200, r.text
    return r.json()


def snap(client, sid, **params):
    r = client.get(f"/api/du/scans/{sid}/tree", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def wait_done(client, sid, timeout=30):
    deadline = time.time() + timeout
    while True:
        s = snap(client, sid, depth=0)
        if not s["status"]["running"]:
            return s
        assert time.time() < deadline, "scan did not finish"
        time.sleep(0.05)


def child(tree, name):
    return next(c for c in tree["children"] if c.get("name") == name)


@pytest.mark.parametrize("workers", [8, 0], ids=["processes", "inline"])
def test_totals_match_du(client, disk_tree, monkeypatch, workers):
    monkeypatch.setattr(du_api, "WORKERS", workers)
    sid = start(client, disk_tree)["id"]
    status = wait_done(client, sid)["status"]
    assert status["disk"] == du_bytes(disk_tree)
    assert status["apparent"] == du_bytes(disk_tree, apparent=True)
    # the hardlink is counted once, the symlink is not followed
    tree = snap(client, sid, depth=1, min=0)["tree"]
    assert child(tree, "big")["disk"] == du_bytes(disk_tree / "big")
    assert child(tree, "big")["apparent"] < 6 * MB
    assert status["dirs"] == 5 and tree["complete"]   # big, deep, deeper, small, empty


def test_both_metrics_and_sort(client, disk_tree):
    sid = start(client, disk_tree)["id"]
    wait_done(client, sid)
    by_disk = [c["name"] for c in snap(client, sid, depth=1, min=0, metric="disk")["tree"]["children"] if c["kind"] != "rest"]
    by_apparent = [c["name"] for c in snap(client, sid, depth=1, min=0, metric="apparent")["tree"]["children"] if c["kind"] != "rest"]
    assert by_disk[0] == "big"
    assert by_apparent[0] == "sparse.img"   # 50 MB long, almost no blocks


def test_depth_big_files_and_buckets(client, tmp_path):
    root = tmp_path / "r"
    (root / "d").mkdir(parents=True)
    for i in range(10):
        (root / "d" / f"big{i}.bin").write_bytes(b"\1" * (MB + i * 1000))
    for i in range(5):
        (root / "d" / f"tiny{i}").write_text("t")
    sid = start(client, root)["id"]
    wait_done(client, sid)
    t = snap(client, sid, depth=1, min=0)["tree"]
    assert "children" not in child(t, "d")
    d = snap(client, sid, path=str(root / "d"), depth=1, min=0)["tree"]
    files = [c for c in d["children"] if c["kind"] == "file"]
    rest = [c for c in d["children"] if c["kind"] == "rest"]
    assert len(files) == du_walk.TOP_FILES and files[0]["name"] == "big9.bin"
    assert rest[0]["count"] == 10 - du_walk.TOP_FILES + 5
    # tiny items merge into one "others" entry when below the threshold
    merged = snap(client, sid, path=str(root / "d"), depth=1, min=0.2)["tree"]["children"]
    assert merged[-1]["kind"] == "others" and merged[-1]["count"] >= 1


def test_snapshots_while_scanning(client, disk_tree, inline, monkeypatch):
    real = du_api.list_dirs

    def slow(paths):
        time.sleep(0.15)
        return real(paths)

    monkeypatch.setattr(du_api, "list_dirs", slow)
    sid = start(client, disk_tree)["id"]
    first = snap(client, sid, depth=2)
    assert first["status"]["running"]
    assert first["tree"] is not None and not first["tree"]["complete"]
    done = wait_done(client, sid)
    assert done["tree"]["complete"] and done["status"]["disk"] == du_bytes(disk_tree)
    assert start(client, disk_tree)["reused"]   # reopening the page doesn't rescan


def test_mount_points_are_not_entered(client, disk_tree, inline, monkeypatch):
    real = du_api.list_dirs

    def fake_mount(paths):
        out = real(paths)
        for listing in out:
            if listing:
                listing[0][:] = [(n, s, b, m, dev + 1 if n == "big" else dev) for n, s, b, m, dev in listing[0]]
        return out

    monkeypatch.setattr(du_api, "list_dirs", fake_mount)
    sid = start(client, disk_tree)["id"]
    tree = wait_done(client, sid) and snap(client, sid, depth=1, min=0)["tree"]
    big = child(tree, "big")
    assert big["state"] == "mount" and big["disk"] == 0
    monkeypatch.setattr(du_api, "list_dirs", real)
    assert client.post(f"/api/du/scans/{sid}/include", json={"path": str(disk_tree / "big")}, headers=HDR).status_code == 200
    wait_done(client, sid)
    assert child(snap(client, sid, depth=1, min=0)["tree"], "big")["disk"] == du_bytes(disk_tree / "big")


def test_archive_hides_and_subtracts(client, disk_tree):
    sid = start(client, disk_tree)["id"]
    before = wait_done(client, sid)["status"]["disk"]
    big_path = str(disk_tree / "big")
    big = child(snap(client, sid, depth=1, min=0)["tree"], "big")
    r = client.post("/api/du/archive", json={"add": [{"path": big_path, "kind": "dir", "disk": 1}]}, headers=HDR)
    items = r.json()["items"]
    assert [i["path"] for i in items] == [big_path] and items[0]["exists"]
    assert items[0]["disk"] == big["disk"]   # refreshed from the scan
    tree = snap(client, sid, depth=1, min=0)["tree"]
    assert "big" not in [c["name"] for c in tree["children"]]
    assert tree["disk"] == before - big["disk"]
    # a file inside an archived folder doesn't count twice
    client.post("/api/du/archive", json={"add": [{"path": big_path + "/a.bin", "kind": "file"}]}, headers=HDR)
    assert snap(client, sid, depth=1, min=0)["tree"]["disk"] == before - big["disk"]
    # it survives a reload, notices deletion, and can be taken back
    assert len(client.get("/api/du/archive").json()["items"]) == 2
    os.unlink(disk_tree / "big" / "a.bin")
    gone = {i["path"]: i["exists"] for i in client.get("/api/du/archive").json()["items"]}
    assert gone[big_path + "/a.bin"] is False and gone[big_path] is True
    client.post("/api/du/archive", json={"remove": [big_path, big_path + "/a.bin"]}, headers=HDR)
    assert snap(client, sid, depth=0)["tree"]["disk"] == before


def test_rescan_after_cleanup(client, disk_tree):
    sid = start(client, disk_tree)["id"]
    wait_done(client, sid)
    os.unlink(disk_tree / "big" / "deep" / "b.bin")
    r = client.post(f"/api/du/scans/{sid}/rescan", json={"path": str(disk_tree / "big")}, headers=HDR)
    assert r.status_code == 200
    status = wait_done(client, sid)["status"]
    assert status["disk"] == du_bytes(disk_tree)
    assert child(snap(client, sid, depth=1, min=0)["tree"], "big")["disk"] == du_bytes(disk_tree / "big")


def test_stop_and_resume(client, disk_tree, inline, monkeypatch):
    real = du_api.list_dirs
    monkeypatch.setattr(du_api, "list_dirs", lambda paths: (time.sleep(0.2), real(paths))[1])
    sid = start(client, disk_tree)["id"]
    stopped = client.post(f"/api/du/scans/{sid}/stop", headers=HDR).json()
    assert not stopped["running"] and stopped["stopped"]
    client.post(f"/api/du/scans/{sid}/resume", headers=HDR)
    assert wait_done(client, sid)["status"]["disk"] == du_bytes(disk_tree)


def test_unreadable_folder(client, disk_tree):
    locked = disk_tree / "locked"
    locked.mkdir()
    (locked / "secret").write_text("s")
    locked.chmod(0)
    try:
        sid = start(client, disk_tree)["id"]
        status = wait_done(client, sid)["status"]
        assert status["errors"] >= 1
        assert child(snap(client, sid, depth=1, min=0)["tree"], "locked")["state"] == "error"
    finally:
        locked.chmod(0o755)


def test_bad_requests(client, tmp_path):
    assert client.post("/api/du/scans", json={"path": str(tmp_path / "nope")}, headers=HDR).status_code == 400
    assert client.get("/api/du/scans/999/tree").status_code == 404
    assert client.post("/api/du/archive", json={"add": [{"path": "/"}]}, headers=HDR).status_code == 400
    assert client.post("/api/du/archive", json={"add": [{"path": str(tmp_path)}]}).status_code == 403  # no CSRF header
