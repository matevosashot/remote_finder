#!/usr/bin/env bash
# Start Remote Finder on a Unix socket only you can open (~/.cache/remote-finder/app.sock).
# Reach it through an SSH tunnel; see remote_finder/serve.py.
cd "$(dirname "$0")"
exec .venv/bin/python -m remote_finder.serve
