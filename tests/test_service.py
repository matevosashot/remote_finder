"""install_service / uninstall_service: the unit text and the systemctl calls, without touching systemd."""

import os
import pwd
import subprocess
import sys

import pytest

from remote_finder import cli, service


class Calls(list):
    inputs: list


@pytest.fixture
def calls(monkeypatch, tmp_path):
    made = Calls()
    made.inputs = []

    def fake_run(cmd, *, input=None, check=True):
        made.append(cmd)
        made.inputs.append(input)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(service, "run", fake_run)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    return made


def test_user_unit_for_a_socket():
    text = service.unit_text("user", "me", ["--socket", "/home/me/.cache/remote-finder/app.sock"])
    assert f"ExecStart={sys.executable} -m remote_finder --socket /home/me/.cache/remote-finder/app.sock\n" in text
    assert "WantedBy=default.target" in text and "User=" not in text and "Restart=on-failure" in text


def test_system_unit_runs_as_the_user_for_a_port():
    text = service.unit_text("system", "me", ["--port", "9000"])
    assert "User=me" in text and "User=root" not in text
    assert "--port 9000" in text and "WantedBy=multi-user.target" in text and "After=network.target" in text


def test_paths_with_spaces_and_percent_are_quoted():
    text = service.unit_text("user", "me", ["--socket", "/tmp/my dir/100%/a.sock"])
    assert '"/tmp/my dir/100%%/a.sock"' in text


def test_install_user_service(calls, tmp_path, capsys):
    cli.main(["install_service", "--socket", str(tmp_path / "x.sock")])
    unit = tmp_path / "config" / "systemd" / "user" / "remote-finder.service"
    assert f"--socket {tmp_path}/x.sock" in unit.read_text()
    assert calls == [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "remote-finder.service"],
        ["systemctl", "--user", "restart", "remote-finder.service"],
        ["loginctl", "enable-linger", pwd.getpwuid(os.getuid()).pw_name],
    ]
    assert "ssh -N -L 8090:" in capsys.readouterr().out


def test_install_defaults_to_the_private_socket(calls):
    cli.main(["install-service"])
    unit = open(service.unit_path("user")).read()
    assert f"--socket {service.DEFAULT_SOCKET}" in unit


def test_install_with_a_port(calls):
    cli.main(["install_service", "--port", "9000"])
    assert "--port 9000" in open(service.unit_path("user")).read()


def test_system_install_goes_through_sudo(calls, monkeypatch):
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    cli.main(["install_service", "--system", "--port", "9000"])
    name = pwd.getpwuid(os.getuid()).pw_name
    assert calls[0] == ["sudo", "tee", "/etc/systemd/system/remote-finder.service"]
    assert calls[1:] == [["sudo", "systemctl", "daemon-reload"], ["sudo", "systemctl", "enable", "remote-finder.service"],
                         ["sudo", "systemctl", "restart", "remote-finder.service"]]
    assert f"User={name}\n" in calls.inputs[0]  # runs as the invoking user, written via sudo tee


def test_system_install_refuses_plain_root(calls, monkeypatch):
    root = pwd.getpwuid(0)
    monkeypatch.setattr(os, "getuid", lambda: 0)
    monkeypatch.delenv("SUDO_USER", raising=False)
    with pytest.raises(SystemExit, match="root"):
        service.run_as_user("system")
    assert root.pw_name == "root" and calls == []


def test_uninstall_user_service(calls):
    cli.main(["install_service", "--port", "9000"])
    calls.clear()
    cli.main(["uninstall_service"])
    assert not os.path.exists(service.unit_path("user"))
    assert calls == [["systemctl", "--user", "disable", "--now", "remote-finder.service"], ["systemctl", "--user", "daemon-reload"]]
