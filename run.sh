#!/usr/bin/env bash
# Run from a checkout: serves on the private Unix socket (~/.cache/remote-finder/app.sock) unless given flags.
# Installed with pip, use the `remote_finder` command instead.
cd "$(dirname "$0")"
exec .venv/bin/python -m remote_finder "${@:---socket}"
