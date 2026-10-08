# Remote File Explorer

A Finder-style web file manager for this machine. It runs on `127.0.0.1:8090` with no login, rooted at `/`, and is meant to be reached over an SSH tunnel:

```bash
ssh -N -L 8090:127.0.0.1:8090 amatevosyan@192.168.10.60   # then open http://localhost:8090
```

## Run

```bash
./run.sh                                   # foreground
systemctl --user restart remote-file-explorer   # the installed service (starts at boot)
journalctl --user -u remote-file-explorer -f    # logs
```

Setup from scratch: `python3.10 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && scripts/fetch_vendor.sh`.
Tests: `.venv/bin/pytest -q tests`.

## Features

- **Views:** Icons (size slider), List (sortable, expand folders inline), Columns, Gallery, plus an optional preview pane.
- **Selection:** click, Ctrl/⌘-click, Shift-click, rubber band in icon view, type-to-select.
- **Right click:**
  - Open / Open in New Tab / Quick Look / Edit
  - Head… / Tail…
  - Copy Path / Name / Parent Path
  - Download (folders and multiple items as a streamed zip)
  - Compress (zip at max level; `.tar.xz` and `.tar.zst` under Compress As), saved next to the files
  - Extract Here, Show Archive Contents
  - Get Info, Calculate Size
  - Rename, Copy / Cut / Paste, Delete
  - Add to Sidebar, Open Terminal Here
- **Open in new tab:** code with syntax highlighting, JSON tree, rendered Markdown, CSV/TSV table, notebooks, images (arrow keys step through the folder), PDF, audio and video. Big files load in chunks.
- **Head/tail tool:** any line count, jump to a line or byte offset, regex grep (filter or highlight), live follow (`tail -f`), works on multi-GB files.
- **Editor:** CodeMirror. Ctrl/⌘+S saves atomically and warns if the file changed on disk.
- **Upload:** toolbar button or drag files/folders from the desktop. Name conflicts ask Replace / Keep Both / Skip.
- **Terminal:** Ctrl+` toggles it. It docks bottom or right, can be resized, and "Open Terminal Here" `cd`s the running shell.
- **Search:** typing filters the current folder; Enter searches subfolders recursively; Ctrl+P is fuzzy quick open.

## Keyboard (Ctrl = ⌘ on a Mac)

| Key | Action |
|---|---|
| Space | Quick Look |
| Enter | Rename |
| Ctrl+O / Ctrl+↓ / double-click | Open |
| Ctrl+↑ / Backspace | Enclosing folder |
| Ctrl+[ / Ctrl+] | Back / forward |
| Delete / Ctrl+Backspace | Delete |
| Alt+Shift+N | New folder |
| Ctrl+C / X / V | Copy / cut / paste files |
| Ctrl+Alt+C | Copy path |
| Ctrl+I | Get Info |
| Ctrl+E | Edit |
| Alt+1…4 | Icons / List / Columns / Gallery |
| Ctrl+F or / | Filter / search |
| Ctrl+P | Quick open |
| Ctrl+Shift+G | Go to folder |
| Ctrl+Shift+. | Show hidden files |
| Ctrl+` | Terminal |

## Security model

There is no authentication, but a shell is exposed, so:
- The server binds to `127.0.0.1` only.
- Requests whose `Host` isn't a loopback name are rejected (DNS rebinding).
- WebSockets and every change need a matching `Origin`.
- Changes also need an `X-RFE: 1` header, which forces a CORS preflight that is never approved. Websites in your browser can't drive the API.
- User files are served with `Content-Security-Policy: sandbox` and `nosniff`. HTML and SVG are served as plain text unless you choose the sandboxed render.

Settings and bookmarks: `~/.config/rfe/settings.json`. Thumbnail cache: `~/.cache/rfe/thumbs`.
# remote_finder
