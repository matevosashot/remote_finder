import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from remote_finder import settings, thumbs  # noqa: E402
from remote_finder.config import CSRF_HEADER  # noqa: E402
from remote_finder.main import app  # noqa: E402

HDR = {CSRF_HEADER: "1", "Origin": "http://localhost"}


@pytest.fixture(autouse=True)
def isolated_state(tmp_path_factory, monkeypatch):
    """Keep tests away from the real settings file and thumbnail cache."""
    state = tmp_path_factory.mktemp("state")
    monkeypatch.setattr(settings, "PATH", str(state / "settings.json"))
    monkeypatch.setattr(thumbs, "THUMB_DIR", str(state / "thumbs"))


@pytest.fixture
def client():
    return TestClient(app, base_url="http://localhost")


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "a.txt").write_text("alpha\n")
    (tmp_path / "b.py").write_text("print('b')\n")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "c.md").write_text("# c\n")
    (tmp_path / ".hidden").write_text("h")
    os.symlink("a.txt", tmp_path / "link")
    os.symlink("nope", tmp_path / "broken")
    return tmp_path


def wait_job(client, job):
    import time
    for _ in range(400):
        j = client.get(f"/api/jobs/{job['id']}").json()
        if j["status"] != "running":
            return j
        time.sleep(0.025)
    raise AssertionError("job did not finish")
