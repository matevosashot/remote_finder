import io
import os
import tarfile
import zipfile

import pytest

from conftest import HDR, wait_job


@pytest.fixture
def folder(tmp_path):
    d = tmp_path / "proj"
    (d / "inner").mkdir(parents=True)
    (d / "x.txt").write_text("x" * 10000)
    (d / "inner" / "y.txt").write_text("y")
    os.symlink("x.txt", d / "lnk")
    return d


@pytest.mark.parametrize("fmt,ext", [("zip", ".zip"), ("tar.xz", ".tar.xz"), ("tar.zst", ".tar.zst")])
def test_compress_extract_roundtrip(client, folder, fmt, ext):
    j = wait_job(client, client.post("/api/compress", json={"paths": [str(folder)], "format": fmt}, headers=HDR).json())
    assert j["status"] == "done", j
    archive = j["result"]["path"]
    assert archive == str(folder) + ext
    assert not [p for p in os.listdir(folder.parent) if p.endswith(".part")]
    # second compress doesn't overwrite: Finder-style "proj 2.zip"
    j2 = wait_job(client, client.post("/api/compress", json={"paths": [str(folder)], "format": fmt}, headers=HDR).json())
    assert j2["result"]["path"] == str(folder) + " 2" + ext

    listing = client.get("/api/archive/list", params={"path": archive}).json()
    names = {i["name"].rstrip("/") for i in listing["items"]}
    assert {"proj/x.txt", "proj/inner/y.txt"} <= names

    os.rename(folder, str(folder) + ".orig")
    j3 = wait_job(client, client.post("/api/extract", json={"path": archive}, headers=HDR).json())
    assert j3["status"] == "done", j3
    assert j3["result"]["path"] == str(folder)  # single top-level item lands directly
    assert (folder / "x.txt").read_text() == "x" * 10000 and (folder / "inner" / "y.txt").read_text() == "y"
    assert os.readlink(folder / "lnk") == "x.txt"


def test_multi_item_compress_and_wrap(client, folder):
    paths = [str(folder / "x.txt"), str(folder / "inner")]
    j = wait_job(client, client.post("/api/compress", json={"paths": paths}, headers=HDR).json())
    assert j["result"]["path"] == str(folder / "Archive.zip")
    j = wait_job(client, client.post("/api/extract", json={"path": str(folder / "Archive.zip")}, headers=HDR).json())
    assert j["result"]["path"] == str(folder / "Archive")  # several items -> wrapped in a folder
    assert (folder / "Archive" / "x.txt").exists()


def test_zip_slip_blocked(client, tmp_path):
    p = tmp_path / "evil.zip"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("ok.txt", "fine")
        z.writestr("../../escaped.txt", "bad")
    j = wait_job(client, client.post("/api/extract", json={"path": str(p)}, headers=HDR).json())
    assert j["status"] == "error" and "unsafe" in j["error"]
    assert not (tmp_path.parent / "escaped.txt").exists()
    assert not [x for x in os.listdir(tmp_path) if x.endswith(".extracting")]


def test_tar_traversal_blocked(client, tmp_path):
    p = tmp_path / "evil.tar.gz"
    with tarfile.open(p, "w:gz") as t:
        data = b"bad"
        ti = tarfile.TarInfo("../escaped.txt")
        ti.size = len(data)
        t.addfile(ti, io.BytesIO(data))
    j = wait_job(client, client.post("/api/extract", json={"path": str(p)}, headers=HDR).json())
    assert j["status"] == "error"
    assert not (tmp_path.parent / "escaped.txt").exists()


def test_compress_cancel_cleans_up(client, tmp_path):
    d = tmp_path / "big"
    d.mkdir()
    for i in range(30):
        (d / f"f{i}").write_bytes(os.urandom(1 << 20))
    job = client.post("/api/compress", json={"paths": [str(d)], "format": "tar.xz"}, headers=HDR).json()
    client.post(f"/api/jobs/{job['id']}/cancel", headers=HDR)
    j = wait_job(client, job)
    assert j["status"] in ("cancelled", "done")
    if j["status"] == "cancelled":
        assert not [x for x in os.listdir(tmp_path) if x.endswith((".part", ".tar.xz"))]


def test_archive_list(client, folder):
    j = wait_job(client, client.post("/api/compress", json={"paths": [str(folder)]}, headers=HDR).json())
    res = client.get("/api/archive/list", params={"path": j["result"]["path"]}).json()
    names = {i["name"] for i in res["items"]}
    assert {"proj/x.txt", "proj/inner/y.txt", "proj/lnk"} <= names and not res["truncated"]
    res = client.get("/api/archive/list", params={"path": j["result"]["path"], "limit": 1}).json()
    assert len(res["items"]) == 1 and res["truncated"] and res["count"] == len(names)
