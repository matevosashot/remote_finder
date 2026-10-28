"""Command line: help without flags, listen options, argument checks."""

import pytest

from remote_finder import cli


def test_no_arguments_prints_help(capsys):
    with pytest.raises(SystemExit) as e:
        cli.main([])
    assert e.value.code == 2
    assert "--socket" in capsys.readouterr().err


def test_socket_and_port_are_exclusive():
    with pytest.raises(SystemExit) as e:
        cli.main(["--socket", "--port", "9000"])
    assert e.value.code == 2


@pytest.mark.parametrize("argv,expected", [
    (["--socket"], (cli.DEFAULT_SOCKET, None)),
    (["--socket", "/tmp/x.sock"], ("/tmp/x.sock", None)),
    (["--port", "9000"], (None, 9000)),
])
def test_listen_options_reach_serve(monkeypatch, argv, expected):
    seen = []
    monkeypatch.setattr("remote_finder.serve.serve", lambda socket_path=None, port=None: seen.append((socket_path, port)))
    cli.main(argv)
    assert seen == [expected]
