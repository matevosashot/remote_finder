"""Folder listing for the disk usage scan. Runs in worker processes, so the stat calls of several
folders happen in parallel (threads would serialize on the GIL). Kept free of heavy imports so
workers start fast."""

from __future__ import annotations

import os
import stat

BIG_FILE = 1 << 20      # files at least this big are kept by name...
TOP_FILES = 8           # ...at most this many per folder; everything else is summed

# (dirs, big files, hardlinked files, small count, small apparent, small disk, unreadable entries)
Listing = tuple[list, list, list, int, int, int, int]


def list_dirs(batch: list[str]) -> list[Listing | None]:
    """List each folder: subfolders with their stat, the biggest files, and totals for the rest.
    None for a folder that can't be read."""
    out: list[Listing | None] = []
    is_dir, is_link, big_blocks = stat.S_ISDIR, stat.S_ISLNK, BIG_FILE // 512
    for path in batch:
        dirs, big, links = [], [], []
        n_small = small_size = small_blocks = errors = 0
        try:
            with os.scandir(path) as it:
                for de in it:
                    try:
                        st = de.stat(follow_symlinks=False)
                    except OSError:
                        errors += 1
                        continue
                    mode = st.st_mode
                    if is_dir(mode):
                        dirs.append((de.name, st.st_size, st.st_blocks * 512, st.st_mtime, st.st_dev))
                        continue
                    size, blocks = st.st_size, st.st_blocks
                    if st.st_nlink > 1 and not is_link(mode):
                        # counted once per scan, decided by the scan (it sees every folder)
                        links.append((st.st_dev, st.st_ino, de.name, size, blocks * 512, st.st_mtime))
                    elif size >= BIG_FILE or blocks >= big_blocks:
                        big.append((de.name, size, blocks * 512, st.st_mtime))
                    else:
                        n_small += 1
                        small_size += size
                        small_blocks += blocks
        except OSError:
            out.append(None)
            continue
        small_disk = small_blocks * 512
        if len(big) > TOP_FILES:
            big.sort(key=lambda f: max(f[1], f[2]), reverse=True)
            for f in big[TOP_FILES:]:
                n_small += 1
                small_size += f[1]
                small_disk += f[2]
            del big[TOP_FILES:]
        out.append((dirs, big, links, n_small, small_size, small_disk, errors))
    return out


def serve() -> None:
    """Worker loop: read length-prefixed marshal batches of paths on stdin, answer on stdout."""
    import marshal
    import sys

    inp, out = sys.stdin.buffer, sys.stdout.buffer
    while True:
        head = inp.read(4)
        if len(head) < 4:
            return
        paths = marshal.loads(inp.read(int.from_bytes(head, "little")))
        data = marshal.dumps(list_dirs(paths))
        out.write(len(data).to_bytes(4, "little"))
        out.write(data)
        out.flush()


if __name__ == "__main__":
    serve()
