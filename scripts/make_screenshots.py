#!/usr/bin/env python3
"""Regenerate the README screenshots in docs/screenshots from a made-up demo folder.

    .venv/bin/python scripts/make_screenshots.py [--root /tmp/demo] [--out docs/screenshots] [--only NAME...]

Builds a fake home folder (a speech-model project, a dataset, photos...), starts a private
server with HOME pointed at it, and drives the system Chrome with Playwright. The host name
and disk list are faked in the browser, so no real machine details end up in the pictures.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import random
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MARKER = ".remote-finder-demo"
VIEWPORT = {"width": 1440, "height": 880}
FAKE_HOME = {"user": "demo", "host": "workstation"}
FAKE_DISKS = [
    {"mount": "/", "device": "/dev/nvme0n1p2", "fstype": "ext4", "total": 1_000_000_000_000,
     "used": 412_000_000_000, "free": 588_000_000_000},
    {"mount": "/data", "device": "nas:/volume1", "fstype": "nfs4", "total": 16_000_000_000_000,
     "used": 13_900_000_000_000, "free": 2_100_000_000_000},
]

# What the browser sees for the folders above the demo root (instead of the real / and /tmp).
SYSTEM_DIRS = ["bin", "boot", "data", "etc", "home", "opt", "srv", "tmp", "usr", "var"]

rng = random.Random(7)

# ---------------------------------------------------------------- demo content

README = """# Speech Denoiser

A small U-Net that removes background noise from 16 kHz speech.

## Results

| Model | PESQ | STOI | SI-SDR |
|---|---|---|---|
| noisy input | 1.97 | 0.921 | 8.4 dB |
| baseline (Wiener) | 2.21 | 0.928 | 11.0 dB |
| **this repo, epoch 40** | **3.02** | **0.951** | **17.6 dB** |

## Train

```bash
python train.py --config config.yaml
tail -f logs/train.log
```

Checkpoints land in `checkpoints/`, metrics in `results.csv`.
See `notebooks/analysis.ipynb` for the loss curves.
"""

TRAIN_PY = '''"""Train the denoiser. Usage: python train.py --config config.yaml"""

import argparse
import logging
from pathlib import Path

import torch
import yaml
from torch.utils.data import DataLoader

from model import UNet
from data import NoisySpeech

log = logging.getLogger("train")


def train(cfg: dict) -> None:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = UNet(channels=cfg["model"]["channels"], depth=cfg["model"]["depth"]).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=cfg["optim"]["lr"], weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=cfg["optim"]["lr"],
                                                total_steps=cfg["train"]["steps"])
    loader = DataLoader(NoisySpeech(cfg["data"]["manifest"]), batch_size=cfg["train"]["batch"],
                        shuffle=True, num_workers=8, pin_memory=True)
    scaler = torch.cuda.amp.GradScaler()

    step = 0
    for epoch in range(cfg["train"]["epochs"]):
        for noisy, clean in loader:
            noisy, clean = noisy.to(device), clean.to(device)
            with torch.autocast(device.type, dtype=torch.bfloat16):
                loss = torch.nn.functional.l1_loss(model(noisy), clean)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            step += 1
            log.info("epoch %d step %d | loss=%.4f lr=%.1e", epoch, step, loss.item(), sched.get_last_lr()[0])
        torch.save(model.state_dict(), Path("checkpoints") / f"epoch_{epoch:03d}.pt")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
    train(yaml.safe_load(open(args.config)))
'''

CONFIG_YAML = """model:
  channels: 48
  depth: 5

data:
  manifest: data/manifest.jsonl
  sample_rate: 16000
  segment_seconds: 4.0
  noise_types: [babble, street, cafe, white]
  snr_db: [-5, 20]

optim:
  lr: 3.0e-4

train:
  epochs: 40
  batch: 32
  steps: 240000
"""

WORDS = ("the of and a to in is you that it he was for on are as with his they at be this have from or one had by "
         "word but not what all were we when your can said there use an each which she do how their if will up other "
         "about out many then them these so some her would make like him into time has look two more write go see "
         "number no way could people my than first water been call who oil its now find long down day did get come "
         "made may part").split()


def sentence(n: int) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(n)).capitalize() + "."


def landscape(w: int, h: int, palette: tuple) -> Image.Image:
    """A soft generated landscape: sky gradient, sun, layered ridges."""
    sky_top, sky_bottom, sun, ridges = palette
    im = Image.new("RGB", (w, h))
    px = ImageDraw.Draw(im)
    for y in range(h):
        t = y / h
        px.line([(0, y), (w, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(sky_top, sky_bottom)))
    sx, sy, r = rng.randint(w // 5, 4 * w // 5), rng.randint(h // 6, h // 2), rng.randint(h // 14, h // 8)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([sx - 3 * r, sy - 3 * r, sx + 3 * r, sy + 3 * r], fill=sun + (70,))
    im.paste(glow.filter(ImageFilter.GaussianBlur(r)), (0, 0), glow.filter(ImageFilter.GaussianBlur(r)))
    px.ellipse([sx - r, sy - r, sx + r, sy + r], fill=sun)
    for i, color in enumerate(ridges):
        base = h * (0.55 + 0.12 * i)
        amp, freq, phase = h * (0.12 - 0.02 * i), rng.uniform(1.5, 3.5), rng.uniform(0, 6.28)
        pts = [(x, base - amp * (0.6 * math.sin(freq * x / w * 6.28 + phase) + 0.4 * math.sin(3.7 * x / w * 6.28)))
               for x in range(0, w + 8, 8)]
        px.polygon(pts + [(w, h), (0, h)], fill=color)
    return im


PALETTES = [
    ((255, 170, 120), (255, 226, 190), (255, 245, 220), [(176, 110, 120), (120, 72, 96), (70, 44, 70)]),
    ((70, 130, 200), (190, 220, 245), (255, 250, 230), [(90, 140, 120), (56, 104, 92), (30, 70, 64)]),
    ((30, 30, 70), (230, 120, 90), (255, 200, 150), [(80, 50, 80), (50, 32, 58), (26, 18, 36)]),
    ((140, 200, 230), (230, 245, 250), (255, 255, 240), [(170, 190, 210), (120, 140, 170), (80, 96, 130)]),
    ((250, 200, 90), (255, 240, 200), (255, 255, 230), [(200, 140, 70), (150, 96, 50), (96, 60, 36)]),
    ((20, 40, 80), (90, 120, 170), (240, 240, 255), [(40, 70, 100), (26, 50, 76), (14, 30, 50)]),
]


def loss_chart(w: int = 720, h: int = 360) -> bytes:
    """A small PNG line chart for the notebook output."""
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    left, top, right, bottom = 50, 20, w - 20, h - 40
    d.rectangle([left, top, right, bottom], outline=(200, 200, 200))
    for i in range(1, 5):
        y = top + (bottom - top) * i / 5
        d.line([(left, y), (right, y)], fill=(238, 238, 238))
    for color, start, end, noise in [((31, 119, 180), 0.95, 0.28, 0.02), ((255, 127, 14), 0.9, 0.34, 0.012)]:
        pts = []
        for i in range(120):
            t = i / 119
            v = end + (start - end) * math.exp(-4 * t) + rng.uniform(-noise, noise)
            pts.append((left + (right - left) * t, bottom - (bottom - top) * v))
        d.line(pts, fill=color, width=3)
    d.text((left, bottom + 12), "epoch 0", fill=(90, 90, 90))
    d.text((right - 50, bottom + 12), "epoch 40", fill=(90, 90, 90))
    d.text((right - 150, top + 10), "train loss", fill=(31, 119, 180))
    d.text((right - 150, top + 26), "val loss", fill=(255, 127, 14))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def notebook() -> dict:
    md = lambda s: {"cell_type": "markdown", "metadata": {}, "source": s}
    code = lambda n, s, outs: {"cell_type": "code", "execution_count": n, "metadata": {}, "source": s, "outputs": outs}
    return {
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": {"name": "python3", "language": "python", "display_name": "Python 3"}},
        "cells": [
            md("# Training analysis\n\nLoss curves and metrics for the 40-epoch run."),
            code(1, "import pandas as pd\nres = pd.read_csv('../results.csv')\nres.tail(3)",
                 [{"output_type": "execute_result", "execution_count": 1, "metadata": {}, "data": {"text/plain":
                   "    epoch  train_loss  val_loss   pesq   stoi  si_sdr\n37     38      0.2861    0.3392  3.004  0.950  17.41\n"
                   "38     39      0.2843    0.3388  3.011  0.951  17.52\n39     40      0.2829    0.3381  3.020  0.951  17.60"}}]),
            code(2, "ax = res.plot(x='epoch', y=['train_loss', 'val_loss'])\nax.set_title('L1 loss')",
                 [{"output_type": "display_data", "metadata": {},
                   "data": {"image/png": base64.b64encode(loss_chart()).decode(), "text/plain": "<Figure>"}}]),
            md("Validation loss flattens after **epoch 30**; PESQ keeps improving slowly."),
            code(3, "print(f\"best PESQ {res.pesq.max():.3f} at epoch {res.pesq.idxmax() + 1}\")",
                 [{"output_type": "stream", "name": "stdout", "text": "best PESQ 3.020 at epoch 40\n"}]),
        ],
    }


def write_train_log(path: Path, lines: int = 240_000) -> None:
    t0 = time.mktime((2026, 9, 28, 9, 0, 0, 0, 0, -1))
    with open(path, "w") as f:
        for i in range(1, lines + 1):
            step, epoch = i, 1 + (i - 1) * 40 // lines  # one line per step, 40 epochs
            loss = 0.283 + 0.62 * math.exp(-5 * i / lines) + rng.uniform(-0.012, 0.012)  # matches results.csv
            ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t0 + i * 3.1))
            if i % 9973 == 0:
                f.write(f"{ts} | WARNING | epoch {epoch} step {step} | gradient overflow, skipping step (scale=32768)\n")
            elif i % 61_111 == 0:
                f.write(f"{ts} | ERROR | dataloader worker 3 crashed: corrupt file audio/spk{i % 900:04d}/utt0012.flac, restarting\n")
            else:
                f.write(f"{ts} | INFO | epoch {epoch} step {step} | loss={loss:.4f} lr={3e-4 * (1 - i / lines) + 1e-6:.1e} "
                        f"grad_norm={rng.uniform(0.6, 2.4):.2f} | {rng.randint(380, 430)} samples/s\n")


def set_times(root: Path) -> None:
    """Spread modification dates over the last weeks (newest: the training log), children before parents."""
    now = time.time()
    special = {"train.log": 600, "eval.log": 3600, "epoch_040.pt": 2 * 86400, "epoch_030.pt": 9 * 86400,
               "epoch_020.pt": 16 * 86400, "epoch_010.pt": 23 * 86400}
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        for name in filenames + dirnames:
            age = special.get(name, rng.uniform(3, 40) * 86400)
            os.utime(os.path.join(dirpath, name), (now - age, now - age), follow_symlinks=False)


def sparse(path: Path, size: int) -> None:
    with open(path, "wb") as f:
        f.truncate(size)  # big-looking checkpoint that takes no disk space


def add_disk_hogs(root: Path) -> None:
    """Big downloads, caches and dataset shards for the disk usage shot (sparse: no real disk space)."""
    hogs = {
        "Downloads/ubuntu-24.04.1-desktop-amd64.iso": 6_114_656_256,
        "Downloads/cuda_12.4.1_550.54.15_linux.run": 4_389_213_532,
        "datasets/noisy-speech-full/shards/train-00000-of-00003.tar": 1_610_612_736,
        "datasets/noisy-speech-full/shards/train-00001-of-00003.tar": 1_610_612_736,
        "datasets/noisy-speech-full/shards/train-00002-of-00003.tar": 1_288_490_188,
        "datasets/noisy-speech-full/shards/dev-00000-of-00001.tar": 402_653_184,
        ".cache/huggingface/hub/models--openai--whisper-small/blobs/model.safetensors": 967_102_729,
        ".cache/pip/http-v2/wheels/torch-2.5.1-cp310-cp310-linux_x86_64.whl": 906_354_624,
        ".local/share/Trash/files/old-checkpoints.tar": 2_254_857_830,
        "projects/web-dashboard/node_modules/.cache/webpack/default-production.pack": 312_475_648,
    }
    for rel, size in hogs.items():
        path = root / rel
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            sparse(path, size)


def build_demo(root: Path) -> None:
    if root.exists():
        if not (root / MARKER).exists():
            sys.exit(f"{root} exists and is not a demo folder made by this script; pass --root elsewhere")
        shutil.rmtree(root)
    root.mkdir(parents=True)
    (root / MARKER).write_text("made by scripts/make_screenshots.py\n")
    (root / ".zshrc").write_text("PROMPT='%F{green}demo@workstation%f:%F{blue}%~%f$ '\nRPROMPT=''\n")

    proj = root / "projects" / "speech-denoiser"
    for d in ("checkpoints", "data", "logs", "notebooks", "src"):
        (proj / d).mkdir(parents=True)
    (proj / "README.md").write_text(README)
    (proj / "train.py").write_text(TRAIN_PY)
    (proj / "config.yaml").write_text(CONFIG_YAML)
    (proj / "requirements.txt").write_text("torch==2.5.1\ntorchaudio==2.5.1\npyyaml==6.0.2\npesq==0.0.4\npystoi==0.4.1\n")
    (proj / "src" / "model.py").write_text("import torch\n\n\nclass UNet(torch.nn.Module):\n    ...\n")
    (proj / "src" / "data.py").write_text("from torch.utils.data import Dataset\n\n\nclass NoisySpeech(Dataset):\n    ...\n")
    with open(proj / "results.csv", "w") as f:
        f.write("epoch,train_loss,val_loss,pesq,stoi,si_sdr\n")
        for e in range(1, 41):
            f.write(f"{e},{0.28 + 0.6 * math.exp(-e / 7):.4f},{0.338 + 0.5 * math.exp(-e / 7):.4f},"
                    f"{3.02 - 1.0 * math.exp(-e / 9):.3f},{0.951 - 0.03 * math.exp(-e / 9):.3f},{17.6 - 9 * math.exp(-e / 9):.2f}\n")
    with open(proj / "data" / "manifest.jsonl", "w") as f:
        for i in range(5000):
            f.write(json.dumps({"id": f"spk{i % 251:04d}_utt{i:05d}", "audio": f"audio/spk{i % 251:04d}/utt{i:05d}.flac",
                                "duration": round(rng.uniform(1.5, 12), 2), "snr_db": round(rng.uniform(-5, 20), 1),
                                "noise": rng.choice(["babble", "street", "cafe", "white"]),
                                "text": sentence(rng.randint(5, 14))}) + "\n")
    write_train_log(proj / "logs" / "train.log")
    (proj / "logs" / "eval.log").write_text("".join(f"epoch {e} | pesq={3.02 - math.exp(-e / 9):.3f}\n" for e in range(1, 41)))
    for e in (10, 20, 30, 40):
        sparse(proj / "checkpoints" / f"epoch_{e:03d}.pt", 1_412_000_000 + e * 1000)
    (proj / "notebooks" / "analysis.ipynb").write_text(json.dumps(notebook(), indent=1))

    other = root / "projects" / "web-dashboard"
    (other / "src").mkdir(parents=True)
    (other / "package.json").write_text(json.dumps({"name": "web-dashboard", "version": "0.3.0"}, indent=2))
    (other / "src" / "index.ts").write_text("export const hello = (name: string) => `hello ${name}`;\n")

    ds = root / "datasets" / "noisy-speech-mini"
    for split, n in (("train", 36), ("dev", 12)):
        (ds / split).mkdir(parents=True)
        for i in range(n):
            (ds / split / f"utt{i:05d}.flac").write_bytes(os.urandom(2048 + i * 37))
    with open(ds / "metadata.csv", "w") as f:
        f.write("id,split,duration,snr_db,noise\n")
        for i in range(48):
            f.write(f"utt{i:05d},{'train' if i < 36 else 'dev'},{rng.uniform(1.5, 12):.2f},{rng.uniform(-5, 20):.1f},babble\n")

    photos = root / "photos"
    photos.mkdir()
    names = ["alpine-lake", "desert-dusk", "evening-ridge", "fjord-morning", "golden-hills", "night-pass",
             "north-cliffs", "sunset-valley", "misty-peaks", "canyon-light", "harbor-hills", "winter-range"]
    for i, name in enumerate(names):
        landscape(1600, 1067, PALETTES[i % len(PALETTES)]).save(photos / f"{name}.jpg", quality=88)

    docs = root / "Documents"
    docs.mkdir()
    (docs / "meeting-notes.md").write_text("# Weekly sync\n\n- dataset v2 is ready\n- try a larger U-Net\n")
    (docs / "todo.txt").write_text("rerun eval on the dev split\nupload checkpoints\n")
    downloads = root / "Downloads"
    downloads.mkdir()
    with zipfile.ZipFile(downloads / "pretrained-weights.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("pretrained/config.yaml", CONFIG_YAML)
        zf.writestr("pretrained/README.md", "Weights for the speech denoiser.\n")

    settings = {"bookmarks": [str(root), str(root / "projects"), str(root / "datasets"), str(photos), "/"],
                "view": "list", "iconSize": 72, "showHidden": False, "sort": {"key": "name", "dir": 1},
                "preview": False, "foldersFirst": True}
    add_disk_hogs(root)
    (root / ".config" / "remote-finder").mkdir(parents=True)
    (root / ".config" / "remote-finder" / "settings.json").write_text(json.dumps(settings, indent=2))
    set_times(root)


def fake_listings(root: Path) -> dict[str, dict]:
    """Listings for each folder above the demo root, showing only a tidy system layout."""
    out = {}
    parts = root.parts  # ('/', 'tmp', 'demo')
    for i in range(1, len(parts)):
        path = str(Path(*parts[:i]))
        names = sorted(set((SYSTEM_DIRS if path == "/" else []) + [parts[i]]))
        out[path] = {"path": path, "parent": None if path == "/" else str(Path(path).parent), "mtime_ns": "0",
                     "writable": False, "entries": [{"name": n, "hidden": False, "kind": "dir", "size": 0,
                                                     "mtime": time.time() - 86400 * (3 + j), "perm": "drwxr-xr-x"}
                                                    for j, n in enumerate(names)]}
    return out


# ---------------------------------------------------------------- server + browser

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(root: Path) -> tuple[subprocess.Popen, str]:
    port = free_port()
    env = {**os.environ, "HOME": str(root), "XDG_CONFIG_HOME": str(root / ".config"),
           "XDG_CACHE_HOME": str(root / ".cache"), "ZDOTDIR": str(root)}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "remote_finder.main:app", "--host", "127.0.0.1",
                             "--port", str(port), "--no-access-log"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://localhost:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{base}/api/home", timeout=1)
            return proc, base
        except OSError:
            time.sleep(0.1)
    proc.kill()
    sys.exit("server did not start")


def shoot(root: Path, out: Path, base: str, only: set[str] | None = None) -> None:
    from playwright.sync_api import expect, sync_playwright

    want = lambda name: not only or name in only

    chrome = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
    proj = root / "projects" / "speech-denoiser"
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chrome) if chrome else p.chromium.launch()

        listings = fake_listings(root)
        api = lambda name: (lambda url: urlparse(url).path == f"/api/{name}")

        def on_list(route):
            path = parse_qs(urlparse(route.request.url).query).get("path", [""])[0]
            if path in listings:
                route.fulfill(json=listings[path])
            else:
                route.continue_()

        def new_page(dark: bool = False):
            ctx = browser.new_context(viewport=VIEWPORT, color_scheme="dark" if dark else "light")
            ctx.route(api("home"), lambda r: r.fulfill(json={"home": str(root), **FAKE_HOME}))
            ctx.route(api("disks"), lambda r: r.fulfill(json=FAKE_DISKS))
            ctx.route(api("list"), on_list)
            page = ctx.new_page()
            page.on("pageerror", lambda e: print("page error:", e, file=sys.stderr))
            return page

        def open_folder(page, path: Path, view: str = "list"):
            page.goto(f"{base}/#{path}")
            expect(page.locator(".statusbar")).to_contain_text("item")
            page.keyboard.press(f"Alt+{['icons', 'list', 'columns', 'gallery'].index(view) + 1}")
            page.wait_for_timeout(400)

        def item(page, path: Path):
            return page.locator(f'[data-path="{path}"]').first

        def wait_thumbs(page):
            page.wait_for_function("() => [...document.querySelectorAll('img.thumb, .preview-img')]"
                                   ".every(i => i.complete && i.naturalWidth)", timeout=20000)

        def save(page, name: str):
            page.mouse.move(VIEWPORT["width"] - 5, VIEWPORT["height"] - 5)  # no stray hover effects
            page.wait_for_timeout(300)
            page.screenshot(path=str(out / name))
            print("wrote", out / name)

        # 1. list view with an expanded folder and the preview pane
        if want("list-preview"):
            page = new_page()
            open_folder(page, proj)
            item(page, proj / "checkpoints").locator(".disclosure").click()
            page.click('[data-btn="preview"]')
            item(page, proj / "train.py").click()
            expect(page.locator("aside.preview-pane .hljs")).to_be_visible()
            save(page, "list-preview.png")
            page.click('[data-btn="preview"]')  # settings are shared by the later shots
            page.context.close()

        # 2. icon view with thumbnails
        if want("icons"):
            page = new_page()
            open_folder(page, root / "photos", "icons")
            page.evaluate("() => { const s = document.querySelector('.size-slider'); s.value = 150; "
                          "s.dispatchEvent(new Event('input')); }")
            item(page, root / "photos" / "evening-ridge.jpg").click()
            item(page, root / "photos" / "night-pass.jpg").click(modifiers=["Control"])
            wait_thumbs(page)
            save(page, "icons.png")
            page.evaluate("() => { const s = document.querySelector('.size-slider'); s.value = 72; "
                          "s.dispatchEvent(new Event('input')); }")
            page.context.close()

        # 3. columns view with a Markdown preview
        if want("columns"):
            page = new_page()
            open_folder(page, proj, "columns")
            page.locator(f'.column.current [data-path="{proj / "README.md"}"]').click()
            expect(page.locator(".column-tail .markdown-body h1")).to_be_visible()
            save(page, "columns.png")
            page.context.close()

        # 4. context menu with the Compress As submenu
        if want("context-menu"):
            page = new_page()
            open_folder(page, proj)
            item(page, proj / "data").click()
            item(page, proj / "logs").click(modifiers=["Shift"])
            item(page, proj / "logs").click(button="right")
            page.locator(".menu-item", has_text="Compress As").hover()
            expect(page.locator(".submenu")).to_be_visible()
            page.locator(".submenu .menu-item").first.hover()
            page.screenshot(path=str(out / "context-menu.png"))
            print("wrote", out / "context-menu.png")
            page.keyboard.press("Escape")
            page.context.close()

        # 5. Quick Look on a photo
        if want("quick-look"):
            page = new_page()
            open_folder(page, root / "photos")
            item(page, root / "photos" / "sunset-valley.jpg").click()
            page.keyboard.press(" ")
            page.wait_for_function("() => { const i = document.querySelector('.ql-overlay img'); return i && i.complete && i.naturalWidth; }")
            save(page, "quick-look.png")
            page.context.close()

        # 6. head/tail tool: grep a 25 MB log
        if want("head-tail"):
            page = new_page()
            log = proj / "logs" / "train.log"
            page.goto(f"{base}/tail.html?path={quote(str(log), safe='/')}&mode=head&n=200&grep=WARNING|ERROR&grepmode=filter")
            expect(page.locator("#gutter")).not_to_be_empty()
            save(page, "head-tail.png")
            page.context.close()

        # 7. notebook in the viewer
        if want("viewer-notebook"):
            page = new_page()
            page.goto(f"{base}/viewer.html?path={quote(str(proj / 'notebooks' / 'analysis.ipynb'), safe='/')}")
            page.wait_for_function("() => { const i = document.querySelector('.notebook img'); return i && i.complete; }")
            save(page, "viewer-notebook.png")
            page.context.close()

        # 8. editor
        if want("editor"):
            page = new_page()
            page.goto(f"{base}/editor.html?path={quote(str(proj / 'config.yaml'), safe='/')}")
            page.locator(".CodeMirror").click()
            page.keyboard.press("Control+End")
            page.keyboard.type("  warmup_steps: 2000\n")
            expect(page.locator("#dirty")).to_be_visible()
            save(page, "editor.png")
            page.context.close()

        # 9. terminal docked on the right
        if want("terminal"):
            page = new_page()
            open_folder(page, proj)
            page.keyboard.press("Control+Backquote")
            page.click('.term-bar [title="Move to side / bottom"]')
            page.wait_for_timeout(1200)
            page.locator(".xterm").click()  # the dock button took the focus
            page.keyboard.type("clear; ls -lh checkpoints | tail -n +2 | awk '{print $5, $9}'; tail -n 3 logs/train.log | cut -c1-70\n")
            expect(page.locator(".xterm-rows")).to_contain_text("epoch_040.pt")
            item(page, proj / "logs").click()
            save(page, "terminal.png")
            page.context.close()

        # 10. Ctrl+P quick open
        if want("quick-open"):
            page = new_page()
            open_folder(page, root)
            page.keyboard.press("Control+p")
            expect(page.locator(".qo-input")).to_be_focused()
            page.keyboard.type("log")
            expect(page.locator(".qo-item").nth(2)).to_be_visible()  # several fuzzy matches
            page.wait_for_timeout(300)
            page.screenshot(path=str(out / "quick-open.png"))
            print("wrote", out / "quick-open.png")
            page.context.close()

        # 11. gallery view, dark appearance
        if want("gallery-dark"):
            page = new_page(dark=True)
            open_folder(page, root / "photos", "gallery")
            item(page, root / "photos" / "fjord-morning.jpg").click()
            wait_thumbs(page)
            save(page, "gallery-dark.png")
            page.context.close()

        # 12. disk usage, by apparent size (the demo's big files are sparse), with three items archived
        if want("disk-usage"):
            add_disk_hogs(root)   # also when reusing a demo folder made before they existed
            (root / ".config" / "remote-finder" / "archive.json").unlink(missing_ok=True)  # from an earlier run
            page = new_page()
            page.goto(f"{base}/du.html?path={quote(str(root), safe='/')}")
            expect(page.locator("#status")).to_contain_text("Scanned", timeout=30000)
            page.locator("#metric [data-metric=apparent]").click()
            row = lambda path: page.locator(f'.du-list .row[data-path="{path}"]')
            for folder in (root / "Downloads", root / "datasets"):
                row(folder).locator(".disclosure").click()
                expect(row(folder).locator(".disclosure.open")).to_be_visible()
            row(root / "Downloads" / "ubuntu-24.04.1-desktop-amd64.iso").click()
            row(root / "Downloads" / "cuda_12.4.1_550.54.15_linux.run").click(modifiers=["Control"])
            row(root / ".local").click(modifiers=["Control"])
            page.keyboard.press("Delete")
            expect(page.locator(".du-archive-head .title")).to_contain_text("3 items")
            page.locator(".toast-x").click()
            row(root / "datasets" / "noisy-speech-full").click()
            save(page, "disk-usage.png")
            page.context.close()

        browser.close()


def optimize(out: Path, only: set[str] | None = None) -> None:
    for png in sorted(out.glob("*.png")):
        if only and png.stem not in only:
            continue
        Image.open(png).save(png, optimize=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default="/tmp/demo", type=Path, help="where to build the demo folder")
    ap.add_argument("--out", default=ROOT / "docs" / "screenshots", type=Path)
    ap.add_argument("--only", nargs="+", metavar="NAME",
                    help="retake just these screenshots (e.g. disk-usage), reusing an existing demo folder")
    args = ap.parse_args()
    if not (args.only and (args.root / MARKER).exists()):
        build_demo(args.root)
    proc, base = start_server(args.root)
    try:
        shoot(args.root, args.out, base, set(args.only or ()))
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    optimize(args.out, set(args.only or ()))


if __name__ == "__main__":
    main()
