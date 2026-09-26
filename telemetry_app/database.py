from __future__ import annotations

import sqlite3
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "telemetry.sqlite3"


COLUMNS = (
    "recorded_at", "cpu_percent", "cpu_load_1m", "cpu_load_5m", "memory_percent",
    "disk_percent", "disk_activity_bps", "cpu_temperature_c",
    "battery_temperature_c", "thermal_pressure", "battery_percent", "battery_state",
)


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def init_db(con: sqlite3.Connection) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_samples (
            recorded_at INTEGER PRIMARY KEY,
            cpu_percent REAL NOT NULL,
            cpu_load_1m REAL NOT NULL,
            cpu_load_5m REAL NOT NULL,
            memory_percent REAL NOT NULL,
            disk_percent REAL NOT NULL,
            disk_activity_bps REAL NOT NULL,
            cpu_temperature_c REAL,
            battery_temperature_c REAL,
            thermal_pressure TEXT NOT NULL,
            battery_percent INTEGER,
            battery_state TEXT NOT NULL
        )
    """)
    con.commit()


def save_sample(con: sqlite3.Connection, sample: dict[str, object]) -> None:
    placeholders = ", ".join("?" for _ in COLUMNS)
    con.execute(
        f"INSERT OR REPLACE INTO telemetry_samples ({', '.join(COLUMNS)}) VALUES ({placeholders})",
        [sample.get(column) for column in COLUMNS],
    )
    con.commit()


def latest(con: sqlite3.Connection) -> dict[str, object] | None:
    row = con.execute("SELECT * FROM telemetry_samples ORDER BY recorded_at DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def history(con: sqlite3.Connection, hours: int = 24, limit: int = 1440) -> list[dict[str, object]]:
    since = int(time.time()) - max(1, min(hours, 168)) * 3600
    rows = con.execute(
        "SELECT * FROM telemetry_samples WHERE recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?",
        (since, limit),
    ).fetchall()
    return [dict(row) for row in reversed(rows)]


def prune(con: sqlite3.Connection, retention_days: int = 30) -> None:
    con.execute("DELETE FROM telemetry_samples WHERE recorded_at < ?", (int(time.time()) - retention_days * 86400,))
    con.commit()
