"""Versioned asset URLs: pages carry content hashes, versioned files cache forever, edits change the hash."""

import json
import re
import shutil

import pytest

from remote_finder import assets, fs_api

PAGES = ["/", "/index.html", "/du.html", "/viewer.html", "/editor.html", "/tail.html"]


def import_map(page: str) -> dict:
    return json.loads(re.search(r'<script type="importmap">(.*?)</script>', page).group(1))["imports"]


@pytest.mark.parametrize("url", PAGES)
def test_pages_are_versioned(client, url):
    r = client.get(url)
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
    page = r.text
    # the import map comes before anything that loads a module
    assert page.index('type="importmap"') < min(page.index("modulepreload"), page.index('type="module"'))
    local = re.findall(r'(?:href|src)="(/(?:css|js|vendor)/[^"]+)"', page)
    assert local and all("?v=" in u for u in local), [u for u in local if "?v=" not in u]
    imap = import_map(page)
    assert all(v.startswith(k + "?v=") for k, v in imap.items())
    entry = re.search(r'<script type="module" src="(/js/[^"?]+)', page).group(1)
    preloaded = set(re.findall(r'rel="modulepreload" href="([^"?]+)', page))
    assert preloaded == set(assets.graph(entry)) and entry in preloaded


def test_versioned_files_cache_forever(client):
    page = client.get("/").text
    css = re.search(r'href="(/css/app.css\?v=[^"]+)"', page).group(1)
    assert "immutable" in client.get(css).headers["cache-control"]
    assert "immutable" in client.get(import_map(page)["/js/app.js"]).headers["cache-control"]
    assert client.get("/js/app.js").headers["cache-control"] == "no-cache"
    assert client.get("/vendor/d3/d3.min.js").headers["cache-control"] == "no-cache"


def test_edit_changes_the_hash(tmp_path):
    root = tmp_path / "static"
    shutil.copytree(assets.STATIC, root, ignore=shutil.ignore_patterns("vendor"))
    before = import_map(assets.render_page("du.html", root=str(root)))
    (root / "js" / "util.js").write_text((root / "js" / "util.js").read_text() + "\n// edited\n")
    after = import_map(assets.render_page("du.html", root=str(root)))
    assert before["/js/util.js"] != after["/js/util.js"]
    assert {k: v for k, v in before.items() if k != "/js/util.js"} == {k: v for k, v in after.items() if k != "/js/util.js"}


def test_main_window_gets_boot_data(client):
    page = client.get("/").text
    boot = json.loads(re.search(r"window.RF_BOOT = (.*?);</script>", page).group(1))
    assert boot["home"] == fs_api.home() and "view" in boot["settings"]
    assert "RF_BOOT" not in client.get("/du.html").text


def test_boot_data_cannot_close_the_script():
    out = assets._json({"x": "</script><script>alert(1)</script>"})
    assert "</script>" not in out and json.loads(out)["x"].startswith("</script>")


def test_gzip_for_static_files_only(client, tmp_path):
    gz = {"Accept-Encoding": "gzip"}
    assert client.get("/css/app.css", headers=gz).headers.get("content-encoding") == "gzip"
    big = tmp_path / "big.txt"
    big.write_text("x" * 100_000)
    assert "content-encoding" not in client.get("/api/raw", params={"path": str(big)}, headers=gz).headers
