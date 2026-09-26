from __future__ import annotations

import json
import os
import signal
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .collector import Collector
from .database import connect, history, init_db, latest, prune, save_sample


STATIC = Path(__file__).resolve().parent / "static"
STOP = threading.Event()


class TelemetryHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/current":
            return self.send_json(current_sample() or {"status": "starting"})
        if parsed.path == "/api/history":
            raw_hours = parse_qs(parsed.query).get("hours", ["24"])[0]
            try:
                hours = int(raw_hours)
            except ValueError:
                hours = 24
            return self.send_json(sample_history(hours))
        return super().do_GET()

    def send_json(self, payload, status: int = 200):
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        if self.path.startswith("/api/"):
            return
        super().log_message(format, *args)


def open_db():
    con = connect()
    init_db(con)
    return con


def current_sample():
    con = open_db()
    try:
        return latest(con)
    finally:
        con.close()


def sample_history(hours: int):
    con = open_db()
    try:
        return history(con, hours)
    finally:
        con.close()


def sample_loop(interval: int) -> None:
    collector = Collector()
    while not STOP.is_set():
        started = time.monotonic()
        try:
            con = open_db()
            save_sample(con, collector.collect())
            if int(time.time()) % 3600 < interval:
                prune(con)
            con.close()
        except Exception as exc:
            print(f"Telemetry sample failed: {exc}")
        STOP.wait(max(1, interval - (time.monotonic() - started)))


def main() -> None:
    port = int(os.environ.get("TELEMETRY_PORT", "4190"))
    interval = max(2, int(os.environ.get("TELEMETRY_INTERVAL", "5")))
    con = open_db()
    con.close()
    threading.Thread(target=sample_loop, args=(interval,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), TelemetryHandler)

    def stop(*_):
        STOP.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"Laptop telemetry: http://127.0.0.1:{port}")
    server.serve_forever()
    server.server_close()


if __name__ == "__main__":
    main()
