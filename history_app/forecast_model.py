from __future__ import annotations

import json
import subprocess
import tempfile
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
NODE_CLI = ROOT / "src" / "historyForecastCli.mjs"

LOCATION = {
    "name": "OHZ / Osterholz-Scharmbeck",
    "latitude": 53.226,
    "longitude": 8.795,
    "timezone": "Europe/Berlin",
}

DEFAULTS = {
    "capacity": 10.0,
    "tilt": 35.0,
    "feedCap": 6.0,
}


def build_forecast_url(settings: dict | None = None, forecast_days: int = 3) -> str:
    payload = {
        "settings": {**DEFAULTS, **(settings or {})},
        "forecast_days": forecast_days,
    }
    return _run_shared_model("url", payload)["url"]


def fetch_open_meteo(settings: dict | None = None, timeout_seconds: int = 20) -> dict:
    with urllib.request.urlopen(build_forecast_url(settings), timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8"))


def capture_day_ahead_forecast(
    settings: dict | None = None,
    now: datetime | None = None,
    forecast: dict | None = None,
) -> dict[str, Any]:
    return capture_forecast_snapshot(
        settings=settings,
        now=now,
        forecast=forecast,
        target_offset_days=1,
        source="Open-Meteo day-ahead",
    )


def capture_same_day_forecast(
    settings: dict | None = None,
    now: datetime | None = None,
    forecast: dict | None = None,
) -> dict[str, Any]:
    return capture_forecast_snapshot(
        settings=settings,
        now=now,
        forecast=forecast,
        target_offset_days=0,
        source="Open-Meteo same-day",
    )


def capture_forecast_snapshot(
    settings: dict | None = None,
    now: datetime | None = None,
    forecast: dict | None = None,
    target_offset_days: int = 1,
    source: str = "Open-Meteo day-ahead",
) -> dict[str, Any]:
    effective_settings = {**DEFAULTS, **(settings or {})}
    forecast = forecast or fetch_open_meteo(effective_settings)
    payload = {
        "settings": effective_settings,
        "forecast": forecast,
        "now": now.isoformat() if now else None,
        "target_offset_days": target_offset_days,
        "source": source,
    }
    return _run_shared_model("capture", payload)


def _run_shared_model(command: str, payload: dict[str, Any]) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as handle:
        json.dump(payload, handle)
        payload_path = Path(handle.name)

    try:
        completed = subprocess.run(
            ["node", str(NODE_CLI), command, str(payload_path)],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        raise RuntimeError(f"Shared SolarGen model failed: {detail}") from exc
    finally:
        payload_path.unlink(missing_ok=True)
