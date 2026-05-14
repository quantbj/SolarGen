from __future__ import annotations

import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .database import connect, forecast_detail, init_db, list_comparisons, parse_hourly_values, parse_number, save_actual, save_forecast_run
from .forecast_model import capture_day_ahead_forecast, capture_same_day_forecast

ROOT = Path(__file__).resolve().parents[1]
STATIC = Path(__file__).resolve().parent / "static"


class HistoryHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/comparisons":
            return self.send_json(list_comparisons(db()))
        if parsed.path == "/api/forecast":
            run_id = int(parse_qs(parsed.query).get("id", ["0"])[0])
            detail = forecast_detail(db(), run_id)
            return self.send_json(detail or {"error": "not found"}, status=200 if detail else 404)
        if parsed.path.startswith("/shared/"):
            return self.serve_shared_module(parsed.path)
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            body = self.read_json()
            if parsed.path == "/api/capture":
                snapshot = capture_day_ahead_forecast()
                run_id = save_forecast_run(db(), snapshot)
                return self.send_json({"forecast_run_id": run_id, **snapshot})
            if parsed.path == "/api/capture-today":
                snapshot = capture_same_day_forecast()
                run_id = save_forecast_run(db(), snapshot)
                return self.send_json({"forecast_run_id": run_id, **snapshot})
            if parsed.path == "/api/actuals":
                hourly = body.get("hourly") or []
                if isinstance(hourly, str):
                    hourly = parse_hourly_values(hourly)
                save_actual(
                    db(),
                    body["date"],
                    parse_number(body["total_kwh"]) if body.get("total_kwh") not in (None, "") else None,
                    [parse_number(value) for value in hourly],
                    body.get("source", "manual"),
                    body.get("notes", ""),
                )
                return self.send_json({"saved": True})
            return self.send_json({"error": "not found"}, status=404)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, status=400)


    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def read_json(self):
        length = int(self.headers.get("content-length", "0"))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_json(self, payload, status=200):
        data = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve_shared_module(self, path: str):
        module_name = Path(path).name
        if module_name not in {"chartCore.js", "utils.js"}:
            return self.send_json({"error": "not found"}, status=404)
        module_path = ROOT / "src" / module_name
        data = module_path.read_bytes()
        self.send_response(200)
        self.send_header("content-type", "application/javascript; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def db():
    con = connect()
    init_db(con)
    return con


def main() -> None:
    con = connect()
    init_db(con)
    port = int(os.environ.get("PORT", "4183"))
    server = ThreadingHTTPServer(("127.0.0.1", port), HistoryHandler)
    print(f"SolarGen history app: http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
