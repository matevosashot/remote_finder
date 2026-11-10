"""Launch Claude Here: the tmux commands, without touching the real tmux."""

import subprocess

import pytest
from conftest import HDR

from remote_finder import claude_api


@pytest.fixture
def tmux(monkeypatch):
    calls = []
    state = {"session": True}

    def fake_run(cmd, **kw):
        calls.append(cmd)
        if cmd[1] == "has-session":
            return subprocess.CompletedProcess(cmd, 0 if state["session"] else 1, "", "")
        return subprocess.CompletedProcess(cmd, 0, "@42\n", "")

    monkeypatch.setattr(claude_api.shutil, "which", lambda name: "/usr/bin/tmux")
    monkeypatch.setattr(claude_api.subprocess, "run", fake_run)
    return calls, state


def test_new_window_in_the_existing_session(client, tree, tmux):
    calls, _ = tmux
    r = client.post("/api/claude", json={"cwd": str(tree / "sub")}, headers=HDR)
    assert r.status_code == 200 and r.json() == {"session": "claude", "window_id": "@42", "name": "sub"}
    assert calls[0] == ["/usr/bin/tmux", "has-session", "-t", "=claude"]  # exact name, not "claude-2"
    cmd = calls[1]
    assert cmd[:8] == ["/usr/bin/tmux", "new-window", "-t", "=claude:", "-c", str(tree / "sub"), "-n", "sub"]
    assert "claude --remote-control sub" in cmd[-1] and " -lic " in cmd[-1]


def test_creates_the_session_when_missing(client, tree, tmux):
    calls, state = tmux
    state["session"] = False
    assert client.post("/api/claude", json={"cwd": str(tree)}, headers=HDR).status_code == 200
    assert calls[1][1:5] == ["new-session", "-d", "-s", "claude"]


def test_window_names_avoid_tmux_target_syntax():
    assert claude_api.window_name("/home/me/v1.2:x y") == "v1-2-x-y"
    assert claude_api.window_name("/") == "root"


def test_rejects_files_and_missing_tmux(client, tree, tmux, monkeypatch):
    assert client.post("/api/claude", json={"cwd": str(tree / "a.txt")}, headers=HDR).status_code == 400
    monkeypatch.setattr(claude_api.shutil, "which", lambda name: None)
    r = client.post("/api/claude", json={"cwd": str(tree)}, headers=HDR)
    assert r.status_code == 503 and "tmux" in r.json()["detail"]


def test_needs_the_csrf_header(client, tree, tmux):
    assert client.post("/api/claude", json={"cwd": str(tree)}).status_code == 403
