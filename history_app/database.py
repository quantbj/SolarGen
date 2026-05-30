from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parents[1] / "data" / "solargen_history.sqlite3"
SCHEMA_VERSION = 3


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


def init_db(con: sqlite3.Connection) -> None:
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS forecast_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issued_at TEXT NOT NULL,
          issued_date TEXT NOT NULL,
          target_date TEXT NOT NULL,
          source TEXT NOT NULL,
          location_name TEXT NOT NULL,
          settings_json TEXT NOT NULL,
          weather_json TEXT NOT NULL,
          forecast_total_kwh REAL NOT NULL,
          simple_forecast_total_kwh REAL,
          theoretical_total_kwh REAL NOT NULL,
          delivered_total_kwh REAL NOT NULL,
          curtailed_total_kwh REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(issued_date, target_date, source)
        );

        CREATE TABLE IF NOT EXISTS forecast_hours (
          forecast_run_id INTEGER NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
          hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
          timestamp TEXT NOT NULL,
          theoretical_kwh REAL NOT NULL,
          forecast_kwh REAL NOT NULL,
          delivered_kwh REAL NOT NULL,
          curtailed_kwh REAL NOT NULL,
          irradiance_wm2 REAL NOT NULL,
          cloud_pct REAL NOT NULL,
          rain_mm REAL NOT NULL,
          temp_c REAL NOT NULL,
          PRIMARY KEY (forecast_run_id, hour)
        );

        CREATE TABLE IF NOT EXISTS actual_days (
          date TEXT PRIMARY KEY,
          total_kwh REAL NOT NULL CHECK(total_kwh >= 0),
          source TEXT NOT NULL DEFAULT 'manual',
          notes TEXT NOT NULL DEFAULT '',
          entered_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS actual_hours (
          date TEXT NOT NULL REFERENCES actual_days(date) ON DELETE CASCADE,
          hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
          generation_kwh REAL NOT NULL CHECK(generation_kwh >= 0),
          PRIMARY KEY (date, hour)
        );

        CREATE INDEX IF NOT EXISTS idx_forecast_runs_target_date ON forecast_runs(target_date);
        CREATE INDEX IF NOT EXISTS idx_forecast_runs_issued_at ON forecast_runs(issued_at);

        CREATE TABLE IF NOT EXISTS ecoflow_ticks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          received_at TEXT NOT NULL,
          device_sn TEXT NOT NULL,
          device_name TEXT NOT NULL DEFAULT '',
          topic TEXT NOT NULL DEFAULT '',
          source_timestamp TEXT,
          solar_power_w REAL,
          battery_soc_percent REAL,
          battery_power_w REAL,
          load_power_w REAL,
          grid_power_w REAL,
          raw_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ecoflow_ticks_received_at ON ecoflow_ticks(received_at);
        CREATE INDEX IF NOT EXISTS idx_ecoflow_ticks_device_received ON ecoflow_ticks(device_sn, received_at);
        """
    )
    ensure_column(con, "forecast_runs", "simple_forecast_total_kwh", "REAL")
    backfill_simple_forecasts(con)
    con.execute(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    con.commit()


def save_forecast_run(con: sqlite3.Connection, snapshot: dict[str, Any]) -> int:
    simple_total = snapshot.get("simple_forecast_total_kwh")
    if simple_total is None:
        simple_total = simple_forecast_total(snapshot.get("weather", {}), snapshot.get("hours", []))
    with con:
        con.execute(
            """
            INSERT INTO forecast_runs (
              issued_at, issued_date, target_date, source, location_name,
              settings_json, weather_json, forecast_total_kwh, simple_forecast_total_kwh, theoretical_total_kwh,
              delivered_total_kwh, curtailed_total_kwh
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(issued_date, target_date, source) DO UPDATE SET
              issued_at=excluded.issued_at,
              location_name=excluded.location_name,
              settings_json=excluded.settings_json,
              weather_json=excluded.weather_json,
              forecast_total_kwh=excluded.forecast_total_kwh,
              simple_forecast_total_kwh=excluded.simple_forecast_total_kwh,
              theoretical_total_kwh=excluded.theoretical_total_kwh,
              delivered_total_kwh=excluded.delivered_total_kwh,
              curtailed_total_kwh=excluded.curtailed_total_kwh
            """,
            (
                snapshot["issued_at"],
                snapshot["issued_date"],
                snapshot["target_date"],
                snapshot["source"],
                snapshot["location_name"],
                json.dumps(snapshot["settings"], sort_keys=True),
                json.dumps(snapshot.get("weather", {}), sort_keys=True),
                snapshot["forecast_total_kwh"],
                round(float(simple_total), 3),
                snapshot["theoretical_total_kwh"],
                snapshot["delivered_total_kwh"],
                snapshot["curtailed_total_kwh"],
            ),
        )
        run_id = con.execute(
            "SELECT id FROM forecast_runs WHERE issued_date=? AND target_date=? AND source=?",
            (snapshot["issued_date"], snapshot["target_date"], snapshot["source"]),
        ).fetchone()["id"]
        con.execute("DELETE FROM forecast_hours WHERE forecast_run_id=?", (run_id,))
        con.executemany(
            """
            INSERT INTO forecast_hours (
              forecast_run_id, hour, timestamp, theoretical_kwh, forecast_kwh,
              delivered_kwh, curtailed_kwh, irradiance_wm2, cloud_pct, rain_mm, temp_c
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    run_id,
                    hour["hour"],
                    hour["timestamp"],
                    hour["theoretical_kwh"],
                    hour["forecast_kwh"],
                    hour["delivered_kwh"],
                    hour["curtailed_kwh"],
                    hour["irradiance_wm2"],
                    hour["cloud_pct"],
                    hour["rain_mm"],
                    hour["temp_c"],
                )
                for hour in snapshot["hours"]
            ],
        )
    return int(run_id)


def save_actual(
    con: sqlite3.Connection,
    date: str,
    total_kwh: float | None,
    hourly: list[float] | None = None,
    source: str = "manual",
    notes: str = "",
) -> None:
    validate_date(date)
    hourly = hourly or []
    if hourly and len(hourly) != 24:
        raise ValueError("Hourly actuals must contain exactly 24 values.")
    if any(value < 0 for value in hourly):
        raise ValueError("Hourly actual values must be non-negative.")
    if total_kwh is None:
        if not hourly:
            raise ValueError("Provide a daily total or 24 hourly actual values.")
        total_kwh = sum(hourly)
    if total_kwh < 0:
        raise ValueError("Daily actual total must be non-negative.")

    now = datetime.now().isoformat(timespec="seconds")
    with con:
        con.execute(
            """
            INSERT INTO actual_days(date, total_kwh, source, notes, entered_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
              total_kwh=excluded.total_kwh,
              source=excluded.source,
              notes=excluded.notes,
              updated_at=excluded.updated_at
            """,
            (date, round(float(total_kwh), 3), source, notes, now, now),
        )
        con.execute("DELETE FROM actual_hours WHERE date=?", (date,))
        if hourly:
            con.executemany(
                "INSERT INTO actual_hours(date, hour, generation_kwh) VALUES (?, ?, ?)",
                [(date, hour, round(float(value), 3)) for hour, value in enumerate(hourly)],
            )


def list_comparisons(con: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = con.execute(
        """
        SELECT
          fr.id,
          fr.issued_at,
          fr.issued_date,
          fr.target_date,
          fr.source,
          fr.forecast_total_kwh,
          fr.simple_forecast_total_kwh,
          fr.theoretical_total_kwh,
          fr.delivered_total_kwh,
          fr.curtailed_total_kwh,
          ad.total_kwh AS actual_total_kwh,
          ad.source AS actual_source
        FROM forecast_runs fr
        LEFT JOIN actual_days ad ON ad.date = fr.target_date
        ORDER BY fr.target_date DESC, fr.issued_at DESC,
          CASE WHEN fr.source='Production blend day-ahead' THEN 0 ELSE 1 END,
          fr.source
        """
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        actual = item.get("actual_total_kwh")
        if actual is not None:
            error = actual - item["forecast_total_kwh"]
            simple_error = actual - item["simple_forecast_total_kwh"] if item.get("simple_forecast_total_kwh") is not None else None
            item["error_kwh"] = round(error, 3)
            item["error_pct"] = round((error / item["forecast_total_kwh"]) * 100, 2) if item["forecast_total_kwh"] else None
            item["simple_error_kwh"] = round(simple_error, 3) if simple_error is not None else None
            item["simple_error_pct"] = round((simple_error / item["simple_forecast_total_kwh"]) * 100, 2) if simple_error is not None and item["simple_forecast_total_kwh"] else None
            item.update(hourly_error_metrics(con, item["id"], item["target_date"]))
        else:
            item["error_kwh"] = None
            item["error_pct"] = None
            item["simple_error_kwh"] = None
            item["simple_error_pct"] = None
            item["hourly_mae_kwh"] = None
            item["hourly_rmse_kwh"] = None
            item["hourly_points"] = 0
        result.append(item)
    return result


def forecast_detail(con: sqlite3.Connection, run_id: int) -> dict[str, Any] | None:
    run = con.execute("SELECT * FROM forecast_runs WHERE id=?", (run_id,)).fetchone()
    if not run:
        return None
    hours = [dict(row) for row in con.execute("SELECT * FROM forecast_hours WHERE forecast_run_id=? ORDER BY hour", (run_id,))]
    actual = con.execute("SELECT * FROM actual_days WHERE date=?", (run["target_date"],)).fetchone()
    actual_hours = [dict(row) for row in con.execute("SELECT hour, generation_kwh FROM actual_hours WHERE date=? ORDER BY hour", (run["target_date"],))]
    return {
        "run": dict(run),
        "hours": hours,
        "actual": dict(actual) if actual else None,
        "actual_hours": actual_hours,
        "comparison": next((item for item in list_comparisons(con) if item["id"] == run_id), None),
    }


def hourly_error_metrics(con: sqlite3.Connection, run_id: int, target_date: str) -> dict[str, Any]:
    rows = con.execute(
        """
        SELECT fh.hour, fh.forecast_kwh, ah.generation_kwh
        FROM forecast_hours fh
        JOIN actual_hours ah ON ah.date=? AND ah.hour=fh.hour
        WHERE fh.forecast_run_id=?
        ORDER BY fh.hour
        """,
        (target_date, run_id),
    ).fetchall()
    if not rows:
        return {"hourly_mae_kwh": None, "hourly_rmse_kwh": None, "hourly_points": 0}
    errors = [row["generation_kwh"] - row["forecast_kwh"] for row in rows]
    mae = sum(abs(error) for error in errors) / len(errors)
    rmse = (sum(error * error for error in errors) / len(errors)) ** 0.5
    return {"hourly_mae_kwh": round(mae, 3), "hourly_rmse_kwh": round(rmse, 3), "hourly_points": len(rows)}


def ensure_column(con: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in con.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def backfill_simple_forecasts(con: sqlite3.Connection) -> None:
    runs = con.execute(
        "SELECT id, weather_json FROM forecast_runs WHERE simple_forecast_total_kwh IS NULL"
    ).fetchall()
    for run in runs:
        hours = [
            dict(row)
            for row in con.execute(
                "SELECT irradiance_wm2, rain_mm FROM forecast_hours WHERE forecast_run_id=? ORDER BY hour",
                (run["id"],),
            )
        ]
        con.execute(
            "UPDATE forecast_runs SET simple_forecast_total_kwh=? WHERE id=?",
            (simple_forecast_total(json.loads(run["weather_json"]), hours), run["id"]),
        )


def simple_forecast_total(weather: dict[str, Any], hours: list[dict[str, Any]]) -> float:
    sunshine_hours = float(weather.get("sunshine_duration") or 0) / 3600
    daylight_rain = sum(
        float(hour.get("rain_mm") or 0)
        for hour in hours
        if float(hour.get("irradiance_wm2") or 0) > 0
    )
    return round(max(0, 18.3545 + 2.351 * sunshine_hours - 1.9219 * daylight_rain), 3)


def parse_hourly_values(text: str) -> list[float]:
    stripped = (text or "").strip()
    if not stripped:
        return []
    tokens = re.findall(r"[-+]?\d+(?:[.,]\d+)?", stripped)
    values = [parse_number(token) for token in tokens]
    if len(values) != 24:
        raise ValueError("Hourly actuals must contain exactly 24 values.")
    return values


def parse_number(value: str | float | int) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    normalized = str(value).strip().replace(",", ".")
    if not normalized:
        raise ValueError("Numeric value is empty.")
    return float(normalized)


def validate_date(value: str) -> None:
    datetime.strptime(value, "%Y-%m-%d")
