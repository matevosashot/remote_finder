"""Big folders a page at a time: server-side sort and filter, pages, extras, the cache, slow reads."""

import json
import os

import pytest

from remote_finder import listing

# Intl.Collator(undefined, {numeric: true, sensitivity: "base"}) order, as Chrome sorts them (no ties)
COLLATOR_ORDER = [
    "__init__.py", "_private", ".hidden", "'quote", "(draft)", "[old]", "{tmp}", "@home", "&and", "#notes", "%pct",
    "~backup", "$var", "1abc", "9", "10", "a b", "a_b", "a-b", "a.b", "a1b", "a10b", "ab", "abc", "Abc_def", "abc-def",
    "abc1", "data-2024-01-02.csv", "data-2024-1-3.csv", "eclair", "eclair2", "file1.txt", "file2.txt", "file10.txt",
    "img (1).png", "img (2).png", "img (10).png", "img_1.png", "img-1.png", "img.png", "olfeld", "README.md",
    "readme.txt", "résumé.pdf", "v1.9.0", "v1.9.10", "v1.10.0", "x+y", "x=y", "Z", "zeta",
]


def stream(client, path, **params):
    r = client.get("/api/list/stream", params={"path": str(path), **params})
    assert r.status_code == 200, r.text
    lines = [json.loads(x) for x in r.text.splitlines()]
    return {
        "head": lines[0]["head"], "done": lines[-1], "lines": lines,
        "names": [e["name"] for x in lines for e in x.get("entries", [])],
        "extra": [e["name"] for x in lines for e in x.get("extra", [])],
    }


@pytest.fixture
def folder(tmp_path):
    d = tmp_path / "many"
    d.mkdir()
    for i in range(1, 251):
        (d / f"f{i}.txt").write_text("x" * i)
        os.utime(d / f"f{i}.txt", (1_000_000 + i, 1_000_000 + i))
    (d / "sub1").mkdir()
    (d / "sub2").mkdir()
    (d / ".hidden").write_text("h")
    return d


@pytest.fixture
def stats(monkeypatch):
    """Count the stat calls the listing makes."""
    calls = []
    real = listing.dir_entry
    monkeypatch.setattr(listing, "dir_entry", lambda de: calls.append(de.name) or real(de))
    return calls


def test_name_key_follows_the_browser_collator():
    assert sorted(reversed(COLLATOR_ORDER), key=listing.name_key) == COLLATOR_ORDER


def test_pages_by_name_stat_only_the_page(client, folder, stats):
    first = stream(client, folder, limit=100)
    assert first["head"]["total"] == 252 and first["head"]["path"] == str(folder)
    assert first["names"][:4] == ["sub1", "sub2", "f1.txt", "f2.txt"] and len(first["names"]) == 100
    assert first["done"] == {"done": True, "next": 100, "complete": False}
    assert len(stats) == 100  # readdir gave the names and folders; only the page was stat'ed
    second = stream(client, folder, offset=100, limit=100)
    assert second["names"][0] == "f99.txt" and second["done"]["next"] == 200
    rest = stream(client, folder, offset=200)
    assert len(rest["names"]) == 52 and rest["names"][-1] == "f250.txt" and rest["done"]["complete"]
    backwards = stream(client, folder, limit=3, dir=-1, folders_first=False)
    assert backwards["names"] == ["sub2", "sub1", "f250.txt"]


def test_other_sorts_read_everything_once(client, folder, stats, monkeypatch):
    monkeypatch.setattr(listing, "CACHE_MIN", 0)  # normally only big folders are kept
    newest = stream(client, folder, sort="mtime", dir=-1, limit=4)
    assert newest["names"][2:] == ["f250.txt", "f249.txt"]  # after the folders
    assert len(stats) == 253  # hidden too, so the cache serves any filter
    stats.clear()
    # "More", another sort and a filter within the cache time reuse that read
    more = stream(client, folder, sort="mtime", dir=-1, offset=4, limit=2, reuse=1)
    assert more["names"] == ["f248.txt", "f247.txt"]
    biggest = stream(client, folder, sort="size", dir=-1, folders_first=False, limit=2, reuse=1)
    assert biggest["names"] == ["f250.txt", "f249.txt"]
    with_hidden = stream(client, folder, sort="size", hidden=True, reuse=1)
    assert with_hidden["head"]["total"] == 253 and ".hidden" in with_hidden["names"]
    assert stats == []
    # without reuse (a refresh) the folder is read again
    stream(client, folder, sort="size", limit=1)
    assert len(stats) == 253


def test_filter_hidden_and_extras(client, folder):
    found = stream(client, folder, q="F2")  # case-insensitive, like the filter box
    assert found["head"]["total"] == 1 + 10 + 51 and found["done"]["complete"]
    assert stream(client, folder, hidden=True, folders_first=False, limit=1)["names"] == [".hidden"]
    # rows asked for by name come along even when they sort outside the page, marked as extra
    page = stream(client, folder, limit=5, include=["f250.txt", "f1.txt"])
    assert "f1.txt" in page["names"] and page["extra"] == ["f250.txt"] and page["done"]["next"] == 5


def test_a_slow_read_shows_the_best_page_so_far(client, folder, monkeypatch):
    monkeypatch.setattr(listing, "PROVISIONAL_SECONDS", -1)  # as if every stat were slow
    r = stream(client, folder, sort="mtime", dir=-1, q="f", limit=3)
    pages = [[e["name"] for e in x["provisional"]] for x in r["lines"] if "provisional" in x]
    assert len(pages) == 253 and all(len(p) <= 3 for p in pages)  # one per row read, the best 3 so far
    assert pages[-1] == r["names"] == ["f250.txt", "f249.txt", "f248.txt"]  # then the real page


def test_errors(client, folder):
    assert client.get("/api/list/stream", params={"path": str(folder / "f1.txt")}).status_code == 400
    assert client.get("/api/list/stream", params={"path": str(folder / "nope")}).status_code == 404
    assert client.get("/api/list/stream", params={"path": str(folder), "sort": "bogus"}).status_code == 422
