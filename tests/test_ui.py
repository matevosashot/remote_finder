"""End-to-end UI checks in headless Chrome against a real server on a free port.

Skipped when Playwright or Chrome is missing. Any page error or console error fails the test.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile
from urllib.parse import quote

import pytest

playwright_api = pytest.importorskip("playwright.sync_api")
expect = playwright_api.expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
pytestmark = pytest.mark.skipif(not CHROME, reason="needs a system Chrome/Chromium (Playwright's build is unsupported here)")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def fixture_dir(tmp_path_factory):
    from PIL import Image
    d = tmp_path_factory.mktemp("ui") / "fixture"
    (d / "sub" / "deeper").mkdir(parents=True)
    (d / "photos").mkdir()
    (d / "hello.py").write_text("def hello():\n    return 'hi'\n")
    (d / "README.md").write_text("# Title\n\nSome *markdown* with a [link](hello.py).\n")
    (d / "data.json").write_text(json.dumps({"a": [1, 2, {"b": None}], "c": "text"}))
    (d / "table.csv").write_text("name,n\nbeta,2\nalpha,10\n")
    (d / "nb.ipynb").write_text(json.dumps({"cells": [
        {"cell_type": "markdown", "source": ["# Notebook"]},
        {"cell_type": "code", "execution_count": 1, "source": ["print(1)"],
         "outputs": [{"output_type": "stream", "name": "stdout", "text": ["1\n"]}]}], "metadata": {}}))
    (d / "page.html").write_text("<p id=x>static</p><script>document.title='script ran'</script>")
    (d / ".hidden_file").write_text("h")
    (d / "sub" / "deeper" / "deepnote.txt").write_text("deep\n")
    with open(d / "big.log", "w") as f:
        for i in range(1, 300_001):
            f.write(f"{i:07d} level={'ERROR' if i % 5000 == 0 else 'INFO'} message number {i}\n")
    Image.new("RGB", (64, 48), (220, 30, 30)).save(d / "photos" / "red.png")
    Image.new("RGB", (64, 48), (30, 30, 220)).save(d / "photos" / "blue.jpg")
    with zipfile.ZipFile(d / "archive.zip", "w") as zf:
        zf.writestr("archive/one.txt", "1")
        zf.writestr("archive/two.txt", "2")
    os.symlink("hello.py", d / "link_to_hello.py")
    return d


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    port = _free_port()
    state = tmp_path_factory.mktemp("ui-state")
    env = {**os.environ, "XDG_CONFIG_HOME": str(state / "config"), "XDG_CACHE_HOME": str(state / "cache")}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "remote_finder.main:app", "--host", "127.0.0.1",
                             "--port", str(port), "--no-access-log"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    base = f"http://localhost:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{base}/api/home", timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("server did not start: " + proc.stderr.read().decode()[-2000:])
    yield base
    proc.terminate()
    proc.wait(timeout=10)


@pytest.fixture(scope="module")
def browser():
    with playwright_api.sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, headless=True)
        yield b
        b.close()


@pytest.fixture
def ctx(browser):
    c = browser.new_context(viewport={"width": 1400, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    errors: list[str] = []

    def watch(page):
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)

    c.on("page", watch)
    c.errors = errors
    yield c
    c.close()
    assert not errors, errors


@pytest.fixture
def app(ctx, server, fixture_dir):
    """The main window opened on the fixture folder, in list view."""
    page = ctx.new_page()
    page.goto(f"{server}/#{fixture_dir}")
    expect(page.locator(".statusbar")).to_contain_text("items")
    page.keyboard.press("Alt+2")
    expect(page.locator(".view-host")).to_have_class("view-host view-list")
    return page


def item(page, path):
    return page.locator(f'[data-path="{path}"]').first


def selected_names(page):
    return page.evaluate("() => [...document.querySelectorAll('.sel .name')].map(e => e.textContent)")


def hash_path(page):
    return page.evaluate("() => decodeURIComponent(location.hash.slice(1))")


def wait_until(cond, timeout=5.0):
    deadline = time.time() + timeout
    while not cond():
        if time.time() > deadline:
            raise AssertionError("condition not met in time")
        time.sleep(0.05)


# ---------------------------------------------------------------- main window

def test_views_and_selection(app, fixture_dir):
    assert "Remote Finder" in app.title()
    item(app, fixture_dir / "data.json").click()
    item(app, fixture_dir / "hello.py").click(modifiers=["Control"])
    assert sorted(selected_names(app)) == ["data.json", "hello.py"]
    item(app, fixture_dir / "data.json").click()
    item(app, fixture_dir / "table.csv").click(modifiers=["Shift"])
    expect(app.locator(".statusbar")).to_contain_text("7 selected")
    assert selected_names(app) == ["data.json", "hello.py", "link_to_hello.py", "nb.ipynb", "page.html",
                                   "README.md", "table.csv"]
    for key, view in [("Alt+1", "icons"), ("Alt+3", "columns"), ("Alt+4", "gallery"), ("Alt+2", "list")]:
        app.keyboard.press(key)
        expect(app.locator(".view-host")).to_have_class(f"view-host view-{view}")
        expect(item(app, fixture_dir / "hello.py")).to_be_visible()
    # hidden files toggle
    assert item(app, fixture_dir / ".hidden_file").count() == 0
    app.keyboard.press("Control+Shift+Period")
    expect(item(app, fixture_dir / ".hidden_file")).to_be_visible()
    app.keyboard.press("Control+Shift+Period")
    expect(item(app, fixture_dir / ".hidden_file")).to_have_count(0)


def test_menu_copy_path_and_quicklook(app, fixture_dir):
    item(app, fixture_dir / "hello.py").click(button="right")
    menu = app.locator(".menu").first
    for label in ("Open in New Tab", "Head…", "Copy Path", "Download", "Compress", "Get Info", "Open Terminal Here"):
        expect(menu.locator(".menu-item", has_text=label).first).to_be_visible()
    menu.locator(".menu-item", has_text="Copy Path").first.click()
    expect(app.locator(".toast")).to_contain_text("Copied")
    assert app.evaluate("() => navigator.clipboard.readText()") == str(fixture_dir / "hello.py")

    item(app, fixture_dir / "README.md").click()
    app.keyboard.press(" ")
    expect(app.locator(".ql-overlay .markdown-body h1")).to_have_text("Title")
    app.keyboard.press("ArrowDown")
    expect(app.locator(".ql-title")).not_to_contain_text("README.md")
    app.keyboard.press(" ")
    expect(app.locator(".ql-overlay")).to_have_count(0)



def test_submenu_stays_next_to_its_item(app, fixture_dir):
    """Right-click far from the corner: the Compress As submenu must open beside its row, on screen."""
    app.keyboard.press("Alt+1")
    row = item(app, fixture_dir / "table.csv")
    box = row.bounding_box()
    row.click(button="right", position={"x": box["width"] / 2, "y": box["height"] / 2})
    parent = app.locator(".menu-item", has_text="Compress As")
    parent.hover()
    sub = app.locator(".submenu")
    expect(sub).to_be_visible()
    p, s = parent.bounding_box(), sub.bounding_box()
    vw, vh = app.viewport_size["width"], app.viewport_size["height"]
    assert s["x"] >= 0 and s["y"] >= 0 and s["x"] + s["width"] <= vw and s["y"] + s["height"] <= vh
    assert abs(s["x"] - (p["x"] + p["width"])) < 12 or abs(s["x"] + s["width"] - p["x"]) < 12  # right or left of it
    assert abs(s["y"] - p["y"]) < 20
    sub.locator(".menu-item").first.click()  # clicking inside the submenu works
    expect(app.locator(".menu")).to_have_count(0)


def test_expand_and_type_select(app, fixture_dir):
    item(app, fixture_dir / "sub").locator(".disclosure").click()
    expect(item(app, fixture_dir / "sub" / "deeper")).to_be_visible()
    app.locator(".list-scroll").click(position={"x": 500, "y": 700})
    app.keyboard.type("tab")
    assert selected_names(app) == ["table.csv"]


def test_file_operations(app, fixture_dir):
    # new folder + inline rename
    app.locator(".list-scroll").click(position={"x": 500, "y": 700})
    app.keyboard.press("Alt+Shift+N")
    app.locator(".rename-input").fill("made by test")
    app.locator(".rename-input").press("Enter")
    folder = fixture_dir / "made by test"
    expect(item(app, folder)).to_be_visible()
    assert folder.is_dir()
    # copy a file, paste inside the folder
    item(app, fixture_dir / "hello.py").click()
    app.keyboard.press("Control+c")
    item(app, folder).dblclick()
    expect(app.locator(".statusbar")).to_contain_text("0 items")
    app.keyboard.press("Control+v")
    expect(item(app, folder / "hello.py")).to_be_visible()
    # going up selects the folder we came from
    app.keyboard.press("Control+ArrowUp")
    expect(app.locator(".sel .name")).to_have_text("made by test")
    # compress via menu; archive lands next to it, selected
    item(app, folder).click(button="right")
    app.locator(".menu-item", has_text="Compress “made by test”").click()
    expect(app.locator(".sel .name")).to_have_text("made by test.zip")
    with zipfile.ZipFile(fixture_dir / "made by test.zip") as zf:
        assert "made by test/hello.py" in zf.namelist()
    # extract an archive with one top-level folder
    item(app, fixture_dir / "archive.zip").click(button="right")
    app.locator(".menu-item", has_text="Extract Here").click()
    expect(app.locator(".sel .name")).to_have_text("archive")
    assert sorted(os.listdir(fixture_dir / "archive")) == ["one.txt", "two.txt"]
    # drag a file onto a folder moves it
    item(app, fixture_dir / "made by test.zip").drag_to(item(app, folder))
    expect(item(app, fixture_dir / "made by test.zip")).to_have_count(0)
    wait_until(lambda: (folder / "made by test.zip").exists())
    # delete with confirmation
    for p in (folder, fixture_dir / "archive"):
        item(app, p).click()
        app.keyboard.press("Delete")
        expect(app.locator(".dialog")).to_contain_text("permanently delete")
        app.locator(".dialog .btn.primary").click()
        expect(item(app, p)).to_have_count(0)
        assert not p.exists()


def test_search_quick_open_and_preview(app, fixture_dir):
    app.locator(".search").fill("deepnote")
    app.locator(".search").press("Enter")
    expect(app.locator(".statusbar")).to_contain_text("1 result")
    expect(item(app, fixture_dir / "sub" / "deeper" / "deepnote.txt")).to_be_visible()
    app.locator(".search").press("Escape")
    expect(item(app, fixture_dir / "hello.py")).to_be_visible()

    app.locator(".list-scroll").click(position={"x": 500, "y": 700})
    app.keyboard.press("Control+p")
    expect(app.locator(".qo-input")).to_be_focused()
    app.keyboard.type("deepnote")
    expect(app.locator(".qo-item").first).to_contain_text("deepnote.txt")
    # the match is highlighted in the file name, not spent on the "deeper" folder
    marks = app.locator(".qo-item").first.locator(".qo-name mark")
    expect(marks).to_have_count(8)
    assert "".join(marks.all_text_contents()) == "deepnote"
    app.keyboard.press("Alt+Enter")  # reveal in its folder
    expect(app.locator(".sel .name")).to_have_text("deepnote.txt")
    assert hash_path(app) == str(fixture_dir / "sub" / "deeper")

    app.keyboard.press("Control+ArrowUp")
    app.keyboard.press("Control+ArrowUp")
    app.wait_for_function("p => decodeURIComponent(location.hash.slice(1)) === p", arg=str(fixture_dir))
    item(app, fixture_dir / "data.json").click()
    app.click('[data-btn="preview"]')
    expect(app.locator("aside.preview-pane .json-tree")).to_be_visible()
    app.click('[data-btn="preview"]')
    expect(app.locator("aside.preview-pane")).to_be_hidden()


def test_columns_and_history(app, fixture_dir):
    app.keyboard.press("Alt+3")
    app.locator(f'.column.current [data-path="{fixture_dir / "sub"}"]').click()
    expect(item(app, fixture_dir / "sub" / "deeper")).to_be_visible()
    item(app, fixture_dir / "sub" / "deeper").click()
    app.wait_for_function("p => decodeURIComponent(location.hash.slice(1)) === p", arg=str(fixture_dir / "sub"))
    app.keyboard.press("ArrowLeft")
    app.wait_for_function("p => decodeURIComponent(location.hash.slice(1)) === p", arg=str(fixture_dir))
    app.keyboard.press("Alt+2")
    item(app, fixture_dir / "photos").dblclick()
    app.wait_for_function("p => decodeURIComponent(location.hash.slice(1)) === p", arg=str(fixture_dir / "photos"))
    app.keyboard.press("Control+BracketLeft")
    app.wait_for_function("p => decodeURIComponent(location.hash.slice(1)) === p", arg=str(fixture_dir))
    expect(app.locator(".sel .name")).to_have_text("photos")


def test_get_info_and_sidebar_bookmark(app, fixture_dir):
    item(app, fixture_dir / "sub").click()
    app.keyboard.press("Control+i")
    expect(app.locator(".dialog .info-table")).to_contain_text("Permissions")
    app.locator(".dialog button", has_text="Calculate Size").click()
    expect(app.locator(".dialog .info-table tr", has_text="Size")).to_contain_text("1 files")
    app.keyboard.press("Escape")
    # drop on the Favorites header: dropping on an existing bookmark would move the folder into it
    item(app, fixture_dir / "photos").drag_to(app.locator(".sb-favorites .sb-head"))
    expect(app.locator(f'.sb-item[data-target="{fixture_dir / "photos"}"]')).to_be_visible()
    app.locator(f'.sb-item[data-target="{fixture_dir / "photos"}"]').click()
    app.wait_for_function("p => decodeURIComponent(location.hash.slice(1)) === p", arg=str(fixture_dir / "photos"))


def test_upload_with_conflict(app, fixture_dir, tmp_path):
    src = tmp_path / "up1.txt"
    src.write_text("uploaded\n")
    for expect_dialog in (False, True):
        with app.expect_file_chooser() as fc:
            app.click('[data-btn="upload"]')
        fc.value.set_files([str(src)])
        if expect_dialog:
            expect(app.locator(".dialog")).to_contain_text("already exists")
            app.locator(".dialog button", has_text="Keep Both").click()
            expect(item(app, fixture_dir / "up1 2.txt")).to_be_visible()
        else:
            expect(item(app, fixture_dir / "up1.txt")).to_be_visible()
    assert (fixture_dir / "up1.txt").read_text() == (fixture_dir / "up1 2.txt").read_text() == "uploaded\n"


def test_terminal(app, fixture_dir):
    app.keyboard.press("Control+Backquote")
    rows = app.locator(".xterm-rows")
    expect(app.locator(".term-panel")).to_be_visible()
    app.wait_for_timeout(800)  # login shell startup
    app.keyboard.type("echo TERM_OK_$((40+2)); pwd\n")
    expect(rows).to_contain_text("TERM_OK_42")
    expect(rows).to_contain_text(str(fixture_dir))
    item(app, fixture_dir / "sub").click(button="right")
    app.locator(".menu-item", has_text="Open Terminal Here").click()
    app.wait_for_timeout(500)
    app.keyboard.type("echo NOW=$PWD\n")
    expect(rows).to_contain_text(f"NOW={fixture_dir / 'sub'}")
    workspace = app.locator(".workspace")
    app.click('.term-bar [title="Move to side / bottom"]')
    expect(workspace).to_have_class("workspace dock-right")
    app.click('.term-bar [title="Move to side / bottom"]')
    expect(workspace).to_have_class("workspace dock-bottom")
    app.keyboard.press("Control+Backquote")
    expect(app.locator(".term-panel")).to_be_hidden()


# ---------------------------------------------------------------- new-tab pages

@pytest.mark.parametrize("name,selector,text", [
    ("hello.py", ".code-view .hljs .hljs-keyword", "def"),
    ("README.md", ".markdown-body h1", "Title"),
    ("data.json", ".json-tree .j-str", '"text"'),
    ("table.csv", "table.csv tbody tr:first-child td:nth-child(2)", "beta"),
    ("nb.ipynb", ".notebook .nb-cell h1", "Notebook"),
    ("photos/red.png", ".img-stage img", None),
    ("page.html", ".code-view", "<script>"),
])
def test_viewer(ctx, server, fixture_dir, name, selector, text):
    page = ctx.new_page()
    page.goto(f"{server}/viewer.html?path={quote(str(fixture_dir / name))}")
    target = page.locator(selector).first
    expect(target).to_be_visible()
    if text:
        expect(target).to_contain_text(text)
    assert page.title() != "script ran"


def test_viewer_html_render_is_sandboxed(ctx, server, fixture_dir):
    page = ctx.new_page()
    page.goto(f"{server}/viewer.html?path={quote(str(fixture_dir / 'page.html'))}")
    page.locator(".seg-btn", has_text="Render").click()
    frame = page.frame_locator("iframe.full-frame")
    expect(frame.locator("#x")).to_have_text("static")
    assert page.title() == "page.html"  # the script ran inside the sandbox, not in our page


def test_viewer_big_file_loads_in_chunks(ctx, server, fixture_dir):
    page = ctx.new_page()
    page.goto(f"{server}/viewer.html?path={quote(str(fixture_dir / 'big.log'))}")
    expect(page.locator(".load-more")).to_contain_text("Showing")
    page.locator(".load-more button", has_text="Load More").click()
    expect(page.locator(".code-view")).to_have_count(2)


def test_tail_tool(ctx, server, fixture_dir):
    log = fixture_dir / "big.log"
    page = ctx.new_page()
    page.goto(f"{server}/tail.html?path={quote(str(log))}&mode=tail&n=5")
    expect(page.locator("#text")).to_contain_text("0300000 level=")
    page.select_option("#mode", "line")
    page.fill("#start", "250000")
    page.fill("#n", "3")
    page.click("button[type=submit]")
    expect(page.locator("#gutter")).to_have_text("250000\n250001\n250002")
    page.select_option("#mode", "head")
    page.fill("#grep", "level=ERROR")
    page.click("button[type=submit]")
    expect(page.locator("#gutter")).to_have_text("5000\n10000\n15000")
    page.fill("#grep", "")
    page.select_option("#mode", "tail")
    page.check("#follow")
    expect(page.locator("#status")).to_contain_text("following")
    with open(log, "a") as f:
        f.write("APPENDED LINE\n")
    expect(page.locator("#text")).to_contain_text("APPENDED LINE")


def test_editor_save(ctx, server, fixture_dir):
    path = fixture_dir / "hello.py"
    page = ctx.new_page()
    page.goto(f"{server}/editor.html?path={quote(str(path))}")
    page.locator(".CodeMirror").click()
    page.keyboard.press("Control+End")
    page.keyboard.type("\n# edited by test\n")
    expect(page.locator("#dirty")).to_be_visible()
    page.keyboard.press("Control+s")
    expect(page.locator("#msg")).to_contain_text("Saved")
    expect(page.locator("#dirty")).to_be_hidden()
    assert "# edited by test" in path.read_text()


def test_page_path_bar(ctx, server, fixture_dir):
    """Standalone pages show the full path (readable URL, clickable folders, copy button)."""
    deep = fixture_dir / "sub" / "deeper" / "odd #name dir"
    deep.mkdir(exist_ok=True)
    f = deep / "part_0001.meta.jsonl"
    f.write_text('{"a": 1}\n{"a": 2}\n')
    page = ctx.new_page()
    page.goto(f"{server}/tail.html?path={quote(str(f), safe='/')}&mode=head&n=200")
    bar = page.locator("#path .path-crumbs")
    expect(bar).to_have_text(str(f))
    assert "%2F" not in page.url and "/sub/deeper/" in page.url
    page.locator("#path button", has_text="Copy Path").click()
    assert page.evaluate("() => navigator.clipboard.readText()") == str(f)
    page.evaluate("() => navigator.clipboard.writeText('')")
    page.locator("#name").click()  # the name copies too
    assert page.evaluate("() => navigator.clipboard.readText()") == str(f)
    with ctx.expect_page() as new:
        page.locator("#path a", has_text="odd #name dir").click()
    folder = new.value
    folder.wait_for_function("p => decodeURIComponent(location.hash.slice(1)) === p", arg=str(deep))
    expect(folder.locator(f'[data-path="{f}"]')).to_be_visible()


# ---------------------------------------------------------------- disk usage page

def test_disk_usage_page(ctx, server, app, tmp_path):
    root = tmp_path / "du root"
    (root / "big dir").mkdir(parents=True)
    (root / "it's here").mkdir()
    (root / "small").mkdir()
    (root / "big dir" / "a.bin").write_bytes(os.urandom(3 << 20))
    (root / "it's here" / "b.bin").write_bytes(os.urandom(2 << 20))
    (root / "small" / "x.txt").write_text("x")
    # opened from the main window's menu
    app.goto(f"{server}/#{root}")
    expect(item(app, str(root / "small"))).to_be_visible()
    app.locator(".view-host").click(button="right", position={"x": 600, "y": 400})
    with ctx.expect_page() as new:
        app.locator(".menu-item", has_text="Analyze Disk Usage").click()
    page = new.value
    expect(page.locator("#status")).to_contain_text("Scanned", timeout=20000)
    assert page.locator(".du-stage path.du-seg").count() >= 3
    page.locator("#chart-kind [data-kind=treemap]").click()
    assert page.locator(".du-stage rect.du-seg").count() >= 3
    page.locator("#chart-kind [data-kind=rings]").click()

    odd = str(root / "it's here")
    row = page.locator(f'.du-list .row[data-path="{odd}"]')
    before = page.locator("#meta").text_content()
    row.click()
    page.keyboard.press("Delete")
    expect(row).to_have_count(0)
    expect(page.locator(".du-archive-head .title")).to_contain_text("1 item")
    assert page.locator("#meta").text_content() != before   # subtracted from the total
    page.keyboard.press("Control+z")
    expect(row).to_have_count(1)
    expect(page.locator("#meta")).to_have_text(before)
    page.keyboard.press("Control+Shift+z")
    expect(row).to_have_count(0)

    page.locator("button", has_text="Show Delete Command").click()
    cmd = page.locator("textarea.du-cmd").input_value()
    assert cmd == "rm -rf -- \\\n  '" + odd.replace("'", "'\\''") + "'\n"
    # what bash would delete is exactly the archived path
    argv = subprocess.run(["bash", "-c", cmd.replace("rm -rf --", "printf '%s\\0'", 1)], capture_output=True, check=True).stdout
    assert argv.split(b"\0")[:-1] == [odd.encode()]
    page.keyboard.press("Escape")
    assert (root / "it's here" / "b.bin").exists()   # nothing was deleted

    # double-click zooms in, Backspace zooms out
    page.locator(f'.du-list .row[data-path="{root / "big dir"}"]').dblclick()
    expect(page.locator("#name")).to_have_text("big dir")
    page.keyboard.press("Backspace")
    expect(page.locator("#name")).to_have_text("du root")
