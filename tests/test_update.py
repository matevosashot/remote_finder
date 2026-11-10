"""Update check (cached a day, only when asked) and the pip upgrade command."""

import sys

import pytest
from conftest import HDR

from remote_finder import update

PIP = {"commit": "a" * 40, "kind": "pip", "user": True}
COMPARE = {"ahead_by": 2, "commits": [
    {"sha": "b" * 40, "commit": {"message": "First change\n\ndetails"}},
    {"sha": "c" * 40, "commit": {"message": "Second change"}},
]}


@pytest.fixture
def gh(monkeypatch, tmp_path):
    calls = []
    answer = {"value": COMPARE}

    def fake(base):
        calls.append(base)
        if isinstance(answer["value"], Exception):
            raise answer["value"]
        return answer["value"]

    monkeypatch.setattr(update, "CACHE", str(tmp_path / "update.json"))
    monkeypatch.setattr(update, "installed", lambda: dict(PIP))
    monkeypatch.setattr(update, "fetch_compare", fake)
    return calls, answer


def test_reports_new_commits_and_caches_for_a_day(gh):
    calls, _ = gh
    s = update.status(now=1000)
    assert s["behind"] == 2 and s["latest"] == "c" * 40 and s["kind"] == "pip"
    assert s["commits"] == [{"sha": "bbbbbbb", "message": "First change"}, {"sha": "ccccccc", "message": "Second change"}]
    assert update.status(now=1000 + 3600)["behind"] == 2
    assert calls == ["a" * 40]  # one request for both
    update.status(now=1000 + update.DAY + 1)
    assert len(calls) == 2  # a day later it asks again


def test_a_failed_check_is_cached_too(gh):
    calls, answer = gh
    answer["value"] = OSError("offline")
    assert update.status(now=0)["behind"] == 0
    assert update.status(now=60)["error"] == "offline" and len(calls) == 1


def test_a_new_install_checks_again(gh, monkeypatch):
    calls, _ = gh
    update.status(now=0)
    monkeypatch.setattr(update, "installed", lambda: {**PIP, "commit": "c" * 40})
    update.status(now=60)
    assert calls == ["a" * 40, "c" * 40]


def test_unknown_install_has_no_check(monkeypatch):
    monkeypatch.setattr(update, "installed", lambda: None)
    assert update.status() == {"enabled": False}


def test_pip_command_matches_the_install():
    assert update.pip_command(PIP) == [sys.executable, "-m", "pip", "install", "--upgrade", "--quiet", "--user",
                                       "git+https://github.com/matevosashot/remote_finder.git@main"]
    assert "--user" not in update.pip_command({**PIP, "user": False})


def test_install_runs_pip_then_restarts(client, gh, monkeypatch):
    ran, timers = [], []
    monkeypatch.setattr(update.subprocess, "run", lambda cmd, **kw: ran.append(cmd) or type("R", (), {"returncode": 0})())
    monkeypatch.setattr(update.threading, "Timer", lambda delay, fn: timers.append(fn) or type("T", (), {"start": lambda self: None})())
    monkeypatch.setattr(update, "launch_args", ["--socket", "/tmp/x.sock"])
    r = client.post("/api/update/install", headers=HDR)
    assert r.json() == {"restarting": True} and ran == [update.pip_command(PIP)] and timers == [update.restart]
    execs = []
    monkeypatch.setattr(update.os, "execv", lambda exe, argv: execs.append(argv))
    update.restart()
    assert execs == [[sys.executable, "-m", "remote_finder", "--socket", "/tmp/x.sock"]]


def test_install_refuses_a_checkout(client, monkeypatch):
    monkeypatch.setattr(update, "installed", lambda: {"commit": "a" * 40, "kind": "checkout", "user": False})
    r = client.post("/api/update/install", headers=HDR)
    assert r.status_code == 400 and "git pull" in r.json()["detail"]


def test_install_needs_the_csrf_header(client, gh):
    assert client.post("/api/update/install").status_code == 403


def test_this_checkout_is_detected():
    cur = update.installed()  # the tests run from a git checkout
    assert cur and cur["kind"] == "checkout" and len(cur["commit"]) == 40
