from __future__ import annotations

import json
import re
import subprocess
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Any
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

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

DWD_STATION = {
    "id": "10224",
    "name": "BREMEN",
    "source": "DWD MOSMIX",
}

DWD_MOSMIX_URL = (
    "https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/"
    "single_stations/{station_id}/kml/MOSMIX_L_LATEST_{station_id}.kmz"
)
DWD_MOSMIX_STATION_DIR = (
    "https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/"
    "single_stations/{station_id}/kml/"
)
DWD_DAY_AHEAD_SIMPLE_CURRENT_WEIGHT = 0.25
DWD_DAY_AHEAD_SIMPLE_RAW_WEIGHT = 0.75
DWD_DAY_AHEAD_SIMPLE_BIAS_KWH = 4.039
DWD_SIMPLE_CALIBRATION_BASIS = (
    "leave-one-target-date-out day-ahead history through 2026-05-29; "
    "best stable model blends 25% current model with 75% raw sunshine/rain simple model"
)
PRODUCTION_BLEND_SOURCE = "Production blend day-ahead"
PRODUCTION_BLEND_OM_WEIGHT = 0.71
PRODUCTION_BLEND_DWD_WEIGHT = 0.29
PRODUCTION_BLEND_BIAS_KWH = -0.113
PRODUCTION_BLEND_BASIS = (
    "leave-one-target-date-out paired OM+DWD day-ahead history through 2026-05-29; "
    "production = 0.71 * OM current + 0.29 * DWD stable simple - 0.113 kWh"
)


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


def capture_dwd_day_ahead_forecast(
    settings: dict | None = None,
    now: datetime | None = None,
    forecast: dict | None = None,
) -> dict[str, Any]:
    normalized = forecast or fetch_dwd_mosmix()
    snapshot = capture_forecast_snapshot(
        settings=settings,
        now=now,
        forecast=normalized,
        target_offset_days=1,
        source="DWD MOSMIX day-ahead",
    )
    snapshot["weather"].update(normalized.get("_dwd_meta", {}))
    apply_dwd_simple_uplift(snapshot)
    return snapshot


def capture_dwd_same_day_forecast(
    settings: dict | None = None,
    now: datetime | None = None,
    forecast: dict | None = None,
) -> dict[str, Any]:
    normalized = forecast or fetch_dwd_same_day_composite(now=now)
    snapshot = capture_forecast_snapshot(
        settings=settings,
        now=now,
        forecast=normalized,
        target_offset_days=0,
        source="DWD MOSMIX same-day",
    )
    snapshot["weather"].update(normalized.get("_dwd_meta", {}))
    apply_dwd_simple_uplift(snapshot)
    return snapshot


def capture_production_day_ahead_forecasts(
    settings: dict | None = None,
    now: datetime | None = None,
    open_meteo_forecast: dict | None = None,
    dwd_forecast: dict | None = None,
) -> list[dict[str, Any]]:
    om_snapshot = capture_day_ahead_forecast(settings=settings, now=now, forecast=open_meteo_forecast)
    dwd_snapshot = capture_dwd_day_ahead_forecast(settings=settings, now=now, forecast=dwd_forecast)
    return [om_snapshot, dwd_snapshot, blend_production_day_ahead(om_snapshot, dwd_snapshot)]


def blend_production_day_ahead(om_snapshot: dict[str, Any], dwd_snapshot: dict[str, Any]) -> dict[str, Any]:
    if om_snapshot["issued_date"] != dwd_snapshot["issued_date"]:
        raise ValueError("OM and DWD production inputs must have the same issued date.")
    if om_snapshot["target_date"] != dwd_snapshot["target_date"]:
        raise ValueError("OM and DWD production inputs must have the same target date.")

    om_total = float(om_snapshot["forecast_total_kwh"])
    dwd_simple_total = float(dwd_snapshot["simple_forecast_total_kwh"])
    production_total = round(max(
        0,
        PRODUCTION_BLEND_OM_WEIGHT * om_total +
        PRODUCTION_BLEND_DWD_WEIGHT * dwd_simple_total +
        PRODUCTION_BLEND_BIAS_KWH,
    ), 3)

    om_hours = sorted(om_snapshot["hours"], key=lambda hour: hour["hour"])
    dwd_hours = sorted(dwd_snapshot["hours"], key=lambda hour: hour["hour"])
    dwd_current_total = sum(float(hour["forecast_kwh"]) for hour in dwd_hours)
    dwd_hour_scale = dwd_simple_total / dwd_current_total if dwd_current_total > 0 else 0
    blended_base = [
        PRODUCTION_BLEND_OM_WEIGHT * float(om_hour["forecast_kwh"]) +
        PRODUCTION_BLEND_DWD_WEIGHT * float(dwd_hour["forecast_kwh"]) * dwd_hour_scale
        for om_hour, dwd_hour in zip(om_hours, dwd_hours)
    ]
    base_total = sum(blended_base)
    production_scale = production_total / base_total if base_total > 0 else 0
    production_hours = [
        {
            **om_hour,
            "forecast_kwh": round(blended_base[index] * production_scale, 3),
            "delivered_kwh": round(blended_base[index] * production_scale, 3),
            "theoretical_kwh": round(blended_base[index] * production_scale, 3),
            "curtailed_kwh": 0,
        }
        for index, om_hour in enumerate(om_hours)
    ]
    production_hour_total = round(sum(hour["forecast_kwh"] for hour in production_hours), 3)
    if production_hours and production_hour_total != production_total:
        production_hours[-1]["forecast_kwh"] = round(
            production_hours[-1]["forecast_kwh"] + production_total - production_hour_total,
            3,
        )
        production_hours[-1]["delivered_kwh"] = production_hours[-1]["forecast_kwh"]
        production_hours[-1]["theoretical_kwh"] = production_hours[-1]["forecast_kwh"]

    weather = {
        **om_snapshot.get("weather", {}),
        "production_model": "OM/DWD two-input blend",
        "production_model_basis": PRODUCTION_BLEND_BASIS,
        "production_om_weight": PRODUCTION_BLEND_OM_WEIGHT,
        "production_dwd_weight": PRODUCTION_BLEND_DWD_WEIGHT,
        "production_bias_kwh": PRODUCTION_BLEND_BIAS_KWH,
        "production_om_current_kwh": round(om_total, 3),
        "production_dwd_simple_kwh": round(dwd_simple_total, 3),
        "production_dwd_current_kwh": round(float(dwd_snapshot["forecast_total_kwh"]), 3),
        "production_dwd_raw_simple_kwh": dwd_snapshot.get("weather", {}).get("dwd_simple_raw_kwh"),
        "production_inputs": [om_snapshot["source"], dwd_snapshot["source"]],
    }
    return {
        **om_snapshot,
        "source": PRODUCTION_BLEND_SOURCE,
        "weather": weather,
        "forecast_total_kwh": production_total,
        "simple_forecast_total_kwh": production_total,
        "theoretical_total_kwh": production_total,
        "delivered_total_kwh": production_total,
        "curtailed_total_kwh": 0,
        "hours": production_hours,
    }


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


def apply_dwd_simple_uplift(snapshot: dict[str, Any]) -> dict[str, Any]:
    source = snapshot.get("source", "")
    if source not in {"DWD MOSMIX day-ahead", "DWD MOSMIX same-day"}:
        return snapshot
    raw_simple = float(snapshot.get("simple_forecast_total_kwh") or 0)
    weather = snapshot.setdefault("weather", {})
    if source == "DWD MOSMIX day-ahead":
        current_total = float(snapshot.get("forecast_total_kwh") or 0)
        snapshot["simple_forecast_total_kwh"] = round(max(
            0,
            DWD_DAY_AHEAD_SIMPLE_CURRENT_WEIGHT * current_total +
            DWD_DAY_AHEAD_SIMPLE_RAW_WEIGHT * raw_simple +
            DWD_DAY_AHEAD_SIMPLE_BIAS_KWH,
        ), 3)
        weather.update(
            {
                "dwd_simple_model": "source-calibrated stable blend",
                "dwd_simple_raw_kwh": round(raw_simple, 3),
                "dwd_simple_current_weight": DWD_DAY_AHEAD_SIMPLE_CURRENT_WEIGHT,
                "dwd_simple_raw_weight": DWD_DAY_AHEAD_SIMPLE_RAW_WEIGHT,
                "dwd_simple_bias_kwh": DWD_DAY_AHEAD_SIMPLE_BIAS_KWH,
                "dwd_simple_uplift_basis": DWD_SIMPLE_CALIBRATION_BASIS,
            }
        )
    else:
        snapshot["simple_forecast_total_kwh"] = round(float(snapshot.get("forecast_total_kwh") or 0), 3)
        weather.update(
            {
                "dwd_simple_model": "hybrid: same-day uses current DWD model because it generalized better than simple uplift",
                "dwd_simple_raw_kwh": round(raw_simple, 3),
                "dwd_simple_uplift_kwh": 0.0,
                "dwd_simple_uplift_basis": DWD_SIMPLE_CALIBRATION_BASIS,
            }
        )
    return snapshot


def build_dwd_mosmix_url(station_id: str = DWD_STATION["id"]) -> str:
    return DWD_MOSMIX_URL.format(station_id=station_id)


def build_dwd_mosmix_run_url(stamp: str, station_id: str = DWD_STATION["id"]) -> str:
    return f"{DWD_MOSMIX_STATION_DIR.format(station_id=station_id)}MOSMIX_L_{stamp}_{station_id}.kmz"


def fetch_dwd_mosmix(station_id: str = DWD_STATION["id"], timeout_seconds: int = 20) -> dict[str, Any]:
    with urllib.request.urlopen(build_dwd_mosmix_url(station_id), timeout=timeout_seconds) as response:
        payload = response.read()
    return dwd_mosmix_kmz_to_open_meteo(payload, station_id=station_id)


def fetch_dwd_mosmix_run(stamp: str, station_id: str = DWD_STATION["id"], timeout_seconds: int = 20) -> dict[str, Any]:
    with urllib.request.urlopen(build_dwd_mosmix_run_url(stamp, station_id), timeout=timeout_seconds) as response:
        payload = response.read()
    return dwd_mosmix_kmz_to_open_meteo(payload, station_id=station_id)


def list_dwd_mosmix_runs(station_id: str = DWD_STATION["id"], timeout_seconds: int = 20) -> list[dict[str, Any]]:
    with urllib.request.urlopen(DWD_MOSMIX_STATION_DIR.format(station_id=station_id), timeout=timeout_seconds) as response:
        listing = response.read().decode("utf-8", errors="replace")
    stamps = sorted(set(re.findall(rf"MOSMIX_L_(\d{{10}})_{re.escape(station_id)}\.kmz", listing)))
    return [
        {
            "stamp": stamp,
            "issue_time_utc": datetime.strptime(stamp, "%Y%m%d%H").replace(tzinfo=timezone.utc),
            "url": build_dwd_mosmix_run_url(stamp, station_id),
        }
        for stamp in stamps
    ]


def fetch_dwd_same_day_composite(
    now: datetime | None = None,
    station_id: str = DWD_STATION["id"],
    timeout_seconds: int = 20,
) -> dict[str, Any]:
    effective_now = ensure_zoned_datetime(now)
    cutoff = effective_now.astimezone(timezone.utc)
    runs = [run for run in list_dwd_mosmix_runs(station_id, timeout_seconds) if run["issue_time_utc"] <= cutoff]
    if not runs:
        raise RuntimeError("No DWD MOSMIX runs are available before the requested same-day capture time.")

    target_date = effective_now.astimezone(ZoneInfo(LOCATION["timezone"])).strftime("%Y-%m-%d")
    forecasts = [fetch_dwd_mosmix_run(run["stamp"], station_id, timeout_seconds) for run in runs[-8:]]
    return compose_dwd_same_day_forecast(forecasts, target_date, effective_now)


def compose_dwd_same_day_forecast(
    forecasts: list[dict[str, Any]],
    target_date: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    cutoff = ensure_zoned_datetime(now).astimezone(timezone.utc)
    target_times = [f"{target_date}T{hour:02d}:00" for hour in range(24)]
    selected: dict[str, dict[str, Any]] = {}

    for forecast in forecasts:
        meta = forecast.get("_dwd_meta", {})
        issue_time = parse_dwd_time(meta.get("issue_time_utc")).astimezone(timezone.utc)
        if issue_time > cutoff:
            continue
        for index, timestamp in enumerate(forecast.get("hourly", {}).get("time", [])):
            if timestamp not in target_times:
                continue
            previous = selected.get(timestamp)
            if previous is None or issue_time > previous["issue_time"]:
                selected[timestamp] = {
                    "issue_time": issue_time,
                    "forecast": forecast,
                    "index": index,
                    "meta": meta,
                }

    missing = [timestamp for timestamp in target_times if timestamp not in selected]
    if missing:
        raise RuntimeError(f"DWD MOSMIX same-day composite is missing {len(missing)} hourly values for {target_date}.")

    hourly = {
        "time": [],
        "temperature_2m": [],
        "cloud_cover": [],
        "precipitation": [],
        "global_tilted_irradiance": [],
        "is_day": [],
        "weather_code": [],
        "sunshine_duration": [],
    }
    issue_times_used = []
    for timestamp in target_times:
        choice = selected[timestamp]
        source_hourly = choice["forecast"]["hourly"]
        index = choice["index"]
        for key in hourly:
            hourly[key].append(source_hourly[key][index])
        issue_times_used.append(choice["meta"].get("issue_time_utc"))

    daily = summarize_hourly_daily(hourly)
    first_meta = next(iter(selected.values()))["meta"]
    return {
        "hourly": hourly,
        "daily": daily,
        "_dwd_meta": {
            **first_meta,
            "same_day_composite": True,
            "target_date": target_date,
            "issue_times_used_utc": sorted(set(issue_times_used)),
            "hour_selection": "newest available DWD MOSMIX forecast for each target hour at capture time",
        },
    }


def dwd_mosmix_kmz_to_open_meteo(payload: bytes, station_id: str = DWD_STATION["id"]) -> dict[str, Any]:
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        kml_name = next(name for name in archive.namelist() if name.endswith(".kml"))
        root = ElementTree.fromstring(archive.read(kml_name))
    return dwd_mosmix_xml_to_open_meteo(root, station_id=station_id)


def dwd_mosmix_xml_to_open_meteo(root: ElementTree.Element, station_id: str = DWD_STATION["id"]) -> dict[str, Any]:
    ns = {
        "dwd": "https://opendata.dwd.de/weather/lib/pointforecast_dwd_extension_V1_0.xsd",
        "kml": "http://www.opengis.net/kml/2.2",
    }
    timezone = ZoneInfo(LOCATION["timezone"])
    issue_time = text_or_empty(root.find(".//dwd:IssueTime", ns))
    placemark = root.find(".//kml:Placemark", ns)
    station_name = text_or_empty(placemark.find("kml:description", ns)) if placemark is not None else DWD_STATION["name"]
    station_code = text_or_empty(placemark.find("kml:name", ns)) if placemark is not None else station_id
    steps = [
        parse_dwd_time(node.text).astimezone(timezone) - timedelta(hours=1)
        for node in root.findall(".//dwd:ForecastTimeSteps/dwd:TimeStep", ns)
    ]
    series = {
        node.attrib.get(f"{{{ns['dwd']}}}elementName"): parse_dwd_values(text_or_empty(node.find("dwd:value", ns)))
        for node in root.findall(".//dwd:Forecast", ns)
    }

    hourly = {
        "time": [],
        "temperature_2m": [],
        "cloud_cover": [],
        "precipitation": [],
        "global_tilted_irradiance": [],
        "is_day": [],
        "weather_code": [],
        "sunshine_duration": [],
    }
    for index, step in enumerate(steps):
        irradiance = max(0.0, value_at(series, "Rad1h", index, 0.0) / 3.6)
        sunshine = value_at(series, "SunD1", index, 0.0)
        hourly["time"].append(step.strftime("%Y-%m-%dT%H:00"))
        hourly["temperature_2m"].append(round(value_at(series, "TTT", index, 289.15) - 273.15, 3))
        hourly["cloud_cover"].append(round(value_at(series, "N", index, 0.0), 3))
        hourly["precipitation"].append(round(value_at(series, "RR1c", index, 0.0), 3))
        hourly["global_tilted_irradiance"].append(round(irradiance, 3))
        hourly["is_day"].append(1 if irradiance > 0 or sunshine > 0 else 0)
        hourly["weather_code"].append(round(value_at(series, "ww", index, 0.0)))
        hourly["sunshine_duration"].append(round(sunshine, 3))

    daily = summarize_dwd_daily(hourly, series, steps)
    return {
        "hourly": hourly,
        "daily": daily,
        "_dwd_meta": {
            "provider": "Deutscher Wetterdienst",
            "product": "MOSMIX_L",
            "station_id": station_code or station_id,
            "station_name": station_name or DWD_STATION["name"],
            "issue_time_utc": issue_time,
            "irradiance_source": "Rad1h horizontal global radiation, converted from kJ/m2 per hour to W/m2 hourly average",
        },
    }


def summarize_hourly_daily(hourly: dict[str, list[Any]]) -> dict[str, list[Any]]:
    temperatures = hourly["temperature_2m"]
    clouds = hourly["cloud_cover"]
    rains = hourly["precipitation"]
    weather_codes = hourly["weather_code"]
    return {
        "time": [hourly["time"][0][:10]],
        "weather_code": [max(weather_codes) if weather_codes else 0],
        "temperature_2m_max": [round(max(temperatures), 3) if temperatures else None],
        "temperature_2m_min": [round(min(temperatures), 3) if temperatures else None],
        "precipitation_sum": [round(sum(rains), 3)],
        "cloud_cover_mean": [round(sum(clouds) / len(clouds), 3) if clouds else 0],
        "sunshine_duration": [round(sum(hourly.get("sunshine_duration", [])), 3)],
    }


def summarize_dwd_daily(hourly: dict[str, list[Any]], series: dict[str, list[float | None]], steps: list[datetime]) -> dict[str, list[Any]]:
    grouped: dict[str, list[int]] = {}
    for index, step in enumerate(steps):
        grouped.setdefault(step.strftime("%Y-%m-%d"), []).append(index)

    daily = {
        "time": [],
        "weather_code": [],
        "temperature_2m_max": [],
        "temperature_2m_min": [],
        "precipitation_sum": [],
        "cloud_cover_mean": [],
        "sunshine_duration": [],
    }
    for date, indexes in grouped.items():
        temperatures = [hourly["temperature_2m"][index] for index in indexes]
        clouds = [hourly["cloud_cover"][index] for index in indexes]
        rains = [hourly["precipitation"][index] for index in indexes]
        weather_codes = [hourly["weather_code"][index] for index in indexes]
        daily["time"].append(date)
        daily["weather_code"].append(max(weather_codes) if weather_codes else 0)
        daily["temperature_2m_max"].append(round(max(temperatures), 3) if temperatures else None)
        daily["temperature_2m_min"].append(round(min(temperatures), 3) if temperatures else None)
        daily["precipitation_sum"].append(round(sum(rains), 3))
        daily["cloud_cover_mean"].append(round(sum(clouds) / len(clouds), 3) if clouds else 0)
        daily["sunshine_duration"].append(round(sum(value_at(series, "SunD1", index, 0.0) for index in indexes), 3))
    return daily


def parse_dwd_time(value: str | None) -> datetime:
    if not value:
        raise ValueError("DWD MOSMIX payload is missing forecast time steps.")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def ensure_zoned_datetime(value: datetime | None = None) -> datetime:
    timezone_info = ZoneInfo(LOCATION["timezone"])
    if value is None:
        return datetime.now(timezone_info)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone_info)
    return value.astimezone(timezone_info)


def parse_dwd_values(text: str) -> list[float | None]:
    values: list[float | None] = []
    for token in text.split():
        try:
            values.append(float(token))
        except ValueError:
            values.append(None)
    return values


def text_or_empty(node: ElementTree.Element | None) -> str:
    return (node.text or "").strip() if node is not None else ""


def value_at(series: dict[str, list[float | None]], name: str, index: int, fallback: float) -> float:
    values = series.get(name, [])
    if index >= len(values) or values[index] is None:
        return fallback
    return float(values[index])


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
