#!/usr/bin/env python3
"""Run the canvas/WebGL scalar-luma calibration in a local Chromium browser."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import threading
from urllib.parse import urlencode


ROOT = Path(__file__).resolve().parents[2]
MAC_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


@contextmanager
def server(directory: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, *_args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_port
    finally:
        httpd.shutdown()
        thread.join()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "artifacts" / "geovideo-calibration")
    parser.add_argument("--width", type=int, default=2048)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--frames", type=int, default=48)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--chromium", default=(
        str(MAC_CHROME) if MAC_CHROME.exists() else shutil.which("chromium") or shutil.which("google-chrome")
    ))
    args = parser.parse_args()
    if not args.chromium:
        parser.error("Chromium executable not found; pass --chromium")
    video = args.input.resolve() / "scalar.mp4"
    if not video.exists():
        parser.error(f"Calibration video not found: {video}")
    page = Path(__file__).with_name("browser-calibration.html")
    with server(Path("/").resolve()) as port:
        params = urlencode({
            "video": video.as_uri().replace("file://", f"http://127.0.0.1:{port}"),
            "width": args.width, "height": args.height, "frames": args.frames, "fps": args.fps,
        })
        page_url = page.resolve().as_uri().replace("file://", f"http://127.0.0.1:{port}")
        completed = subprocess.run([
            args.chromium, "--headless", "--disable-gpu-sandbox", "--autoplay-policy=no-user-gesture-required",
            "--virtual-time-budget=30000", "--dump-dom", f"{page_url}?{params}",
        ], check=True, capture_output=True, text=True)
    marker = '<pre id="result">'
    start = completed.stdout.find(marker)
    end = completed.stdout.find("</pre>", start)
    if start < 0 or end < 0:
        raise RuntimeError("Browser calibration did not return a report")
    raw = completed.stdout[start + len(marker):end].replace("&quot;", '"').replace("&amp;", "&")
    report = json.loads(raw)
    report["browser"] = args.chromium
    output = args.input / "browser-report.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"Report: {output}")
    return 0 if report.get("accepted") else 1


if __name__ == "__main__":
    raise SystemExit(main())
