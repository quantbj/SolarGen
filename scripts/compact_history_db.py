#!/usr/bin/env python3
"""Rewrite the SolarGen history database without long-lived EcoFlow raw payloads."""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from history_app.database import DB_PATH, ECOFLOW_TICK_COLUMNS, init_db
from history_app.ecoflow_store import list_ecoflow_ticks, parse_iso_datetime, save_ecoflow_hourly_generation


TABLE_COLUMNS = {
    "forecast_runs": [
        "id",
        "issued_at",
        "issued_date",
        "target_date",
        "source",
        "location_name",
        "settings_json",
        "weather_json",
        "forecast_total_kwh",
        "simple_forecast_total_kwh",
        "theoretical_total_kwh",
        "delivered_total_kwh",
        "curtailed_total_kwh",
        "created_at",
    ],
    "forecast_hours": [
        "forecast_run_id",
        "hour",
        "timestamp",
        "theoretical_kwh",
        "forecast_kwh",
        "delivered_kwh",
        "curtailed_kwh",
        "irradiance_wm2",
        "cloud_pct",
        "rain_mm",
        "temp_c",
    ],
    "actual_days": ["date", "total_kwh", "source", "notes", "entered_at", "updated_at"],
    "actual_hours": ["date", "hour", "generation_kwh"],
    "ecoflow_ticks": ECOFLOW_TICK_COLUMNS,
}


def open_source(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def open_target(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = OFF")
    con.execute("PRAGMA synchronous = OFF")
    init_db(con)
    return con


def checkpoint_database(path: Path) -> None:
    con = sqlite3.connect(path)
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    finally:
        con.close()


def copy_schema_meta(src: sqlite3.Connection, dst: sqlite3.Connection) -> None:
    rows = src.execute("SELECT key, value FROM schema_meta WHERE key <> 'schema_version'").fetchall()
    dst.executemany(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?, ?)",
        [(row["key"], row["value"]) for row in rows],
    )


def copy_table(src: sqlite3.Connection, dst: sqlite3.Connection, table: str, columns: list[str]) -> int:
    source_columns = {row["name"] for row in src.execute(f"PRAGMA table_info({table})")}
    selected = [column for column in columns if column in source_columns]
    column_sql = ", ".join(selected)
    placeholders = ", ".join("?" for _ in selected)
    insert_sql = f"INSERT INTO {table} ({column_sql}) VALUES ({placeholders})"
    count = 0
    cursor = src.execute(f"SELECT {column_sql} FROM {table}")
    while True:
        batch = cursor.fetchmany(5000)
        if not batch:
            break
        dst.executemany(insert_sql, [tuple(row[column] for column in selected) for row in batch])
        count += len(batch)
    return count


def reset_autoincrement_sequences(con: sqlite3.Connection) -> None:
    for table in ("forecast_runs", "ecoflow_ticks"):
        max_id = con.execute(f"SELECT COALESCE(MAX(id), 0) AS max_id FROM {table}").fetchone()["max_id"]
        con.execute("INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES(?, ?)", (table, max_id))


def refresh_hourly_aggregates(con: sqlite3.Connection, timezone_name: str) -> int:
    bounds = con.execute("SELECT MIN(received_at) AS first, MAX(received_at) AS last FROM ecoflow_ticks").fetchone()
    if not bounds["first"] or not bounds["last"]:
        return 0
    tz = ZoneInfo(timezone_name)
    current = parse_iso_datetime(bounds["first"]).astimezone(tz).date()
    last = parse_iso_datetime(bounds["last"]).astimezone(tz).date()
    days = 0
    while current <= last:
        day = current.isoformat()
        ecoflow = list_ecoflow_ticks(con, day, timezone_name)
        save_ecoflow_hourly_generation(con, day, timezone_name, ecoflow["hourly_generation_kwh"])
        current += timedelta(days=1)
        days += 1
    return days


def build_compact_database(source_path: Path, target_path: Path, timezone_name: str) -> dict[str, int]:
    if target_path.exists():
        target_path.unlink()
    src = open_source(source_path)
    dst = open_target(target_path)
    counts: dict[str, int] = {}
    try:
        with dst:
            copy_schema_meta(src, dst)
            for table, columns in TABLE_COLUMNS.items():
                counts[table] = copy_table(src, dst, table, columns)
            reset_autoincrement_sequences(dst)
            counts["ecoflow_hourly_days"] = refresh_hourly_aggregates(dst, timezone_name)
            dst.execute("PRAGMA optimize")
        check = dst.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"quick_check failed: {check}")
    finally:
        src.close()
        dst.close()
    return counts


def replace_database(source_path: Path, compact_path: Path, backup_dir: Path | None) -> Path | None:
    backup_path = None
    if backup_dir is not None:
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"{source_path.stem}_before_compaction_{timestamp}{source_path.suffix}"
        shutil.copy2(source_path, backup_path)
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{source_path}{suffix}")
        if sidecar.exists():
            sidecar.unlink()
    compact_path.replace(source_path)
    return backup_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DB_PATH)
    parser.add_argument("--timezone", default="Europe/Berlin")
    parser.add_argument("--replace", action="store_true", help="Replace the source DB after successful compaction.")
    parser.add_argument("--no-backup", action="store_true", help="Skip the pre-replacement backup copy.")
    parser.add_argument("--backup-dir", type=Path, default=ROOT / "data" / "backups")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    db_path = args.db.resolve()
    compact_path = db_path.with_name(f"{db_path.name}.compact")
    checkpoint_database(db_path)
    counts = build_compact_database(db_path, compact_path, args.timezone)
    backup_path = None
    if args.replace:
        backup_path = replace_database(
            db_path,
            compact_path,
            None if args.no_backup else args.backup_dir,
        )
    print(f"compact_db={compact_path if compact_path.exists() else db_path}")
    if backup_path:
        print(f"backup_db={backup_path}")
    for table, count in counts.items():
        print(f"{table}={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
