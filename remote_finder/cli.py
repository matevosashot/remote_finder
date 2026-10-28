"""The `remote_finder` command: serve on a socket or port, or install a service that does."""

from __future__ import annotations

import argparse
import sys

from .serve import DEFAULT_SOCKET


def add_listen_args(p: argparse.ArgumentParser) -> None:
    g = p.add_mutually_exclusive_group()
    g.add_argument("--socket", nargs="?", const=DEFAULT_SOCKET, metavar="PATH",
                   help=f"listen on a Unix socket only you can open (default path: {DEFAULT_SOCKET})")
    g.add_argument("--port", type=int, metavar="N",
                   help="listen on 127.0.0.1:N instead (open to every account on this machine)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="remote_finder", description="Finder-style web file manager for remote machines.")
    add_listen_args(p)
    sub = p.add_subparsers(dest="command", metavar="{install_service,uninstall_service}")
    for name, aliases, text in (("install_service", ["install-service"], "install a systemd service that starts on boot"),
                                ("uninstall_service", ["uninstall-service"], "stop and remove that service")):
        sp = sub.add_parser(name, aliases=aliases, help=text, description=text)
        scope = sp.add_mutually_exclusive_group()
        scope.add_argument("--user", dest="scope", action="store_const", const="user", help="per-user service (default)")
        scope.add_argument("--system", dest="scope", action="store_const", const="system",
                           help="system-wide service in /etc/systemd/system (needs sudo); runs as you, not root")
        sp.set_defaults(scope="user")
        if name == "install_service":
            add_listen_args(sp)
    return p


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        if args.socket is None and args.port is None:
            parser.print_help(sys.stderr)
            sys.exit(2)
        from .serve import serve
        serve(socket_path=args.socket, port=args.port)
        return
    from . import service
    cmd = args.command.replace("-", "_")
    if cmd == "install_service":
        service.install(args.scope, socket_path=args.socket, port=args.port)
    else:
        service.uninstall(args.scope)
