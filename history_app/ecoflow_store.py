from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo


def save_ecoflow_tick(con: sqlite3.Connection, tick: dict[str, Any]) -> int:
    received_at = tick.get("received_at") or datetime.now(timezone.utc).isoformat(timespec="seconds")
    raw = tick.get("raw") or {}
    with con:
        cursor = con.execute(
            """
            INSERT INTO ecoflow_ticks (
              received_at, device_sn, device_name, topic, source_timestamp,
              solar_power_w, battery_soc_percent, battery_power_w, load_power_w,
              grid_power_w, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                received_at,
                tick["device_sn"],
                tick.get("device_name", ""),
                tick.get("topic", ""),
                tick.get("source_timestamp"),
                tick.get("solar_power_w"),
                tick.get("battery_soc_percent"),
                tick.get("battery_power_w"),
                tick.get("load_power_w"),
                tick.get("grid_power_w"),
                json.dumps(raw, sort_keys=True),
            ),
        )
    return int(cursor.lastrowid)


def list_ecoflow_ticks(con: sqlite3.Connection, day: str | None = None, timezone_name: str = "Europe/Berlin") -> dict[str, Any]:
    if day is None:
        day = date.today().isoformat()
    validate_date(day)
    start_utc, end_utc = local_day_bounds_utc(day, timezone_name)
    rows = [
        dict(row)
        for row in con.execute(
            """
            SELECT
              id, received_at, device_sn, device_name, topic, source_timestamp,
              solar_power_w, battery_soc_percent, battery_power_w, load_power_w, grid_power_w
            FROM ecoflow_ticks
            WHERE received_at >= ? AND received_at <= ?
            ORDER BY received_at
            """,
            (start_utc.isoformat(timespec="seconds"), end_utc.isoformat(timespec="seconds")),
        )
    ]
    return {
        "date": day,
        "timezone": timezone_name,
        "window_utc": {
            "begin": start_utc.isoformat(timespec="seconds"),
            "end": end_utc.isoformat(timespec="seconds"),
        },
        "tick_count": len(rows),
        "summary": summarize_ecoflow_ticks(rows),
        "hourly_generation_kwh": ecoflow_hourly_generation(rows, timezone_name),
        "ticks": rows,
    }


def summarize_ecoflow_ticks(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {
            "generation_kwh": 0,
            "first_received_at": None,
            "last_received_at": None,
            "latest_solar_power_w": None,
            "latest_battery_soc_percent": None,
        }
    generation_wh = 0.0
    previous = None
    for row in rows:
        current_time = parse_iso_datetime(row["received_at"])
        current_power = row.get("solar_power_w")
        if previous and previous["power"] is not None:
            seconds = max(0.0, min(900.0, (current_time - previous["time"]).total_seconds()))
            generation_wh += float(previous["power"]) * seconds / 3600.0
        previous = {"time": current_time, "power": current_power}

    latest_with_solar = next((row for row in reversed(rows) if row.get("solar_power_w") is not None), None)
    latest_with_soc = next((row for row in reversed(rows) if row.get("battery_soc_percent") is not None), None)
    return {
        "generation_kwh": round(generation_wh / 1000.0, 3),
        "first_received_at": rows[0]["received_at"],
        "last_received_at": rows[-1]["received_at"],
        "latest_solar_power_w": latest_with_solar.get("solar_power_w") if latest_with_solar else None,
        "latest_battery_soc_percent": latest_with_soc.get("battery_soc_percent") if latest_with_soc else None,
    }


def ecoflow_hourly_generation(rows: list[dict[str, Any]], timezone_name: str) -> list[float | None]:
    hourly_wh = [0.0] * 24
    covered = [False] * 24
    tz = ZoneInfo(timezone_name)
    previous = None
    for row in rows:
        current_time = parse_iso_datetime(row["received_at"])
        if previous and previous["power"] is not None:
            interval_end = min(current_time, previous["time"] + timedelta(minutes=15))
            allocate_power_interval(hourly_wh, covered, previous["time"], interval_end, float(previous["power"]), tz)
        previous = {"time": current_time, "power": row.get("solar_power_w")}
    return [round(value / 1000.0, 3) if covered[index] else None for index, value in enumerate(hourly_wh)]


def allocate_power_interval(hourly_wh: list[float], covered: list[bool], start: datetime, end: datetime, power_w: float, tz: ZoneInfo) -> None:
    cursor = start
    while cursor < end:
        local_cursor = cursor.astimezone(tz)
        local_hour_end = local_cursor.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        segment_end = min(end, local_hour_end.astimezone(timezone.utc))
        seconds = max(0.0, (segment_end - cursor).total_seconds())
        hour = local_cursor.hour
        hourly_wh[hour] += power_w * seconds / 3600.0
        covered[hour] = True
        cursor = segment_end


def local_day_bounds_utc(day: str, timezone_name: str) -> tuple[datetime, datetime]:
    tz = ZoneInfo(timezone_name)
    parsed = date.fromisoformat(day)
    start = datetime.combine(parsed, time.min, tzinfo=tz)
    end = datetime.combine(parsed, time.max.replace(microsecond=0), tzinfo=tz)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def parse_iso_datetime(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def validate_date(value: str) -> None:
    datetime.strptime(value, "%Y-%m-%d")
