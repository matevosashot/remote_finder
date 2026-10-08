#!/usr/bin/env bash
# Start Remote Finder on localhost only (no auth; reach it through an SSH tunnel).
cd "$(dirname "$0")"
exec .venv/bin/uvicorn remote_finder.main:app --host 127.0.0.1 --port "${REMOTE_FINDER_PORT:-8090}" --workers 1 --no-access-log
