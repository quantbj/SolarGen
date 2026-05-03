from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

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

CALIBRATION = {
    "date": "2026-05-01",
    "clearDayKwh": 50.23,
}

ROOFTOP_PROFILE = {
    "morningLowUntilHour": 10,
    "eveningDropHour": 17,
    "lowOutputCapKw": 0.95,
    "lowOutputFactor": 0.14,
    "eveningTransitionHours": 0.5,
}

OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast"


@dataclass(frozen=True)
class ForecastHour:
    timestamp: str
    hour: int
    theoretical_kwh: float
    forecast_kwh: float
    delivered_kwh: float
    curtailed_kwh: float
    irradiance_wm2: float
    cloud_pct: float
    rain_mm: float
    temp_c: float


def build_forecast_url(settings: dict | None = None, forecast_days: int = 3) -> str:
    settings = {**DEFAULTS, **(settings or {})}
    params = {
        "latitude": str(LOCATION["latitude"]),
        "longitude": str(LOCATION["longitude"]),
        "timezone": LOCATION["timezone"],
        "forecast_days": str(forecast_days),
        "tilt": str(settings["tilt"]),
        "azimuth": "0",
        "hourly": ",".join([
            "temperature_2m",
            "cloud_cover",
            "precipitation",
            "global_tilted_irradiance",
            "is_day",
            "weather_code",
        ]),
        "daily": ",".join([
            "weather_code",
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "cloud_cover_mean",
            "sunshine_duration",
        ]),
    }
    return f"{OPEN_METEO_ENDPOINT}?{urllib.parse.urlencode(params)}"


def fetch_open_meteo(settings: dict | None = None, timeout_seconds: int = 20) -> dict:
    with urllib.request.urlopen(build_forecast_url(settings), timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8"))


def capture_day_ahead_forecast(settings: dict | None = None, now: datetime | None = None, forecast: dict | None = None) -> dict:
    settings = {**DEFAULTS, **(settings or {})}
    now = now or datetime.now(ZoneInfo(LOCATION["timezone"]))
    issued_date = now.date().isoformat()
    target_date = (now.date() + timedelta(days=1)).isoformat()
    forecast = forecast or fetch_open_meteo(settings)
    hours = simulate_target_day(forecast, target_date, settings)
    if not hours:
        raise ValueError(f"Forecast payload does not contain hourly data for {target_date}")

    weather = daily_weather_for(forecast, target_date)
    return {
        "issued_at": now.isoformat(timespec="seconds"),
        "issued_date": issued_date,
        "target_date": target_date,
        "source": "Open-Meteo day-ahead",
        "location_name": LOCATION["name"],
        "settings": settings,
        "forecast_total_kwh": round(sum(hour.forecast_kwh for hour in hours), 3),
        "theoretical_total_kwh": round(sum(hour.theoretical_kwh for hour in hours), 3),
        "delivered_total_kwh": round(sum(hour.delivered_kwh for hour in hours), 3),
        "curtailed_total_kwh": round(sum(hour.curtailed_kwh for hour in hours), 3),
        "weather": weather,
        "hours": [hour.__dict__ for hour in hours],
    }


def simulate_target_day(forecast: dict, target_date: str, settings: dict) -> list[ForecastHour]:
    hourly = forecast.get("hourly", {})
    times = hourly.get("time", [])
    scale = calibration_scale(settings)
    result: list[ForecastHour] = []

    for index, timestamp in enumerate(times):
        if not timestamp.startswith(f"{target_date}T"):
            continue
        hour = int(timestamp[11:13])
        irradiance = value_at(hourly.get("global_tilted_irradiance"), index, 0.0) or 0.0
        temperature = value_at(hourly.get("temperature_2m"), index, 16.0) or 16.0
        theoretical = max(0.0, (irradiance / 1000.0) * settings["capacity"] * scale * pv_temperature_factor(irradiance, temperature))
        rooftop = apply_rooftop_profile(theoretical, hour, settings)
        curtailed = max(0.0, rooftop - settings["feedCap"])
        delivered = rooftop - curtailed
        result.append(ForecastHour(
            timestamp=timestamp,
            hour=hour,
            theoretical_kwh=round(theoretical, 3),
            forecast_kwh=round(rooftop, 3),
            delivered_kwh=round(delivered, 3),
            curtailed_kwh=round(curtailed, 3),
            irradiance_wm2=round(irradiance, 3),
            cloud_pct=round(value_at(hourly.get("cloud_cover"), index, 0.0) or 0.0, 3),
            rain_mm=round(value_at(hourly.get("precipitation"), index, 0.0) or 0.0, 3),
            temp_c=round(temperature, 3),
        ))
    return result


def daily_weather_for(forecast: dict, target_date: str) -> dict:
    daily = forecast.get("daily", {})
    dates = daily.get("time", [])
    if target_date not in dates:
        return {}
    index = dates.index(target_date)
    return {
        "weather_code": value_at(daily.get("weather_code"), index, None),
        "temperature_2m_max": value_at(daily.get("temperature_2m_max"), index, None),
        "temperature_2m_min": value_at(daily.get("temperature_2m_min"), index, None),
        "precipitation_sum": value_at(daily.get("precipitation_sum"), index, None),
        "cloud_cover_mean": value_at(daily.get("cloud_cover_mean"), index, None),
        "sunshine_duration": value_at(daily.get("sunshine_duration"), index, None),
    }


def calibration_scale(settings: dict) -> float:
    base = []
    for hour in range(24):
        irradiance = clear_sky_poa(CALIBRATION["date"], hour, settings["tilt"])
        base.append((irradiance / 1000.0) * settings["capacity"] * pv_temperature_factor(irradiance, 18.0))

    low = 0.1
    high = 5.0
    for _ in range(32):
        mid = (low + high) / 2
        generated = sum(apply_rooftop_profile(value * mid, hour, settings) for hour, value in enumerate(base))
        if generated < CALIBRATION["clearDayKwh"]:
            low = mid
        else:
            high = mid
    return (low + high) / 2


def apply_rooftop_profile(theoretical: float, hour: int, settings: dict) -> float:
    if theoretical <= 0:
        return 0.0
    low_cap = min(ROOFTOP_PROFILE["lowOutputCapKw"], settings["capacity"])
    low_output = min(theoretical * ROOFTOP_PROFILE["lowOutputFactor"], low_cap)
    if hour < ROOFTOP_PROFILE["morningLowUntilHour"]:
        return low_output
    if hour >= ROOFTOP_PROFILE["eveningDropHour"]:
        return low_output
    transition_start = ROOFTOP_PROFILE["eveningDropHour"] - ROOFTOP_PROFILE["eveningTransitionHours"]
    if hour >= transition_start:
        progress = (hour - transition_start) / ROOFTOP_PROFILE["eveningTransitionHours"]
        return theoretical * (1 - progress) + low_output * progress
    return theoretical


def pv_temperature_factor(irradiance: float, ambient_temperature: float) -> float:
    panel_temp = ambient_temperature + (max(0.0, irradiance) / 800.0) * 20.0
    return clamp(1 - 0.0035 * (panel_temp - 25.0), 0.82, 1.06)


def clear_sky_poa(date_string: str, hour: int, tilt_deg: float) -> float:
    lat = math.radians(LOCATION["latitude"])
    tilt = math.radians(tilt_deg)
    day = day_of_year(date_string)
    decl = math.radians(23.45 * math.sin(math.radians((360 / 365) * (284 + day))))
    b = math.radians((360 / 365) * (day - 81))
    equation_of_time = 9.87 * math.sin(2 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)
    standard_meridian = 15
    time_correction = 4 * (LOCATION["longitude"] - standard_meridian) + equation_of_time
    solar_time = hour + 0.5 + time_correction / 60
    hour_angle = math.radians(15 * (solar_time - 12))
    cos_zenith = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(hour_angle)
    if cos_zenith <= 0:
        return 0.0

    cos_incidence = (
        math.sin(decl) * math.sin(lat) * math.cos(tilt)
        - math.sin(decl) * math.cos(lat) * math.sin(tilt)
        + math.cos(decl) * math.cos(lat) * math.cos(tilt) * math.cos(hour_angle)
        + math.cos(decl) * math.sin(lat) * math.sin(tilt) * math.cos(hour_angle)
    )
    ghi = 1098 * cos_zenith * math.exp(-0.059 / cos_zenith)
    beam = max(0.0, ghi * 0.82 * max(0.0, cos_incidence) / max(0.12, cos_zenith))
    diffuse = ghi * 0.18 * ((1 + math.cos(tilt)) / 2)
    reflected = ghi * 0.2 * ((1 - math.cos(tilt)) / 2)
    return max(0.0, beam + diffuse + reflected)


def day_of_year(date_string: str) -> int:
    parsed = date.fromisoformat(date_string)
    return int(parsed.strftime("%j"))


def value_at(values: list | None, index: int, fallback):
    if isinstance(values, list) and index < len(values) and values[index] is not None:
        return values[index]
    return fallback


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))
