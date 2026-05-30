from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .database import connect, init_db, list_comparisons, parse_hourly_values, save_actual, save_forecast_run
from .forecast_model import LOCATION, capture_day_ahead_forecast, capture_dwd_day_ahead_forecast, capture_dwd_same_day_forecast, capture_production_day_ahead_forecasts, capture_same_day_forecast


def main() -> None:
    parser = argparse.ArgumentParser(description="SolarGen local forecast history database")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db", help="Create or migrate the local SQLite database")

    capture = sub.add_parser("capture", help="Fetch and store the current day-ahead forecast")
    capture.add_argument("--at", help="ISO timestamp used as issue time, mainly for tests/backfill")

    capture_today = sub.add_parser("capture-today", help="Fetch and store the current same-day forecast")
    capture_today.add_argument("--at", help="ISO timestamp used as issue time, mainly for tests/backfill")

    capture_dwd = sub.add_parser("capture-dwd", help="Fetch and store the current DWD MOSMIX day-ahead forecast")
    capture_dwd.add_argument("--at", help="ISO timestamp used as issue time, mainly for tests/backfill")

    capture_dwd_today = sub.add_parser("capture-dwd-today", help="Fetch and store the current DWD MOSMIX same-day composite forecast")
    capture_dwd_today.add_argument("--at", help="ISO timestamp used as issue time, mainly for tests/backfill")

    capture_production = sub.add_parser("capture-production", help="Fetch OM and DWD day-ahead inputs and store the production blend forecast")
    capture_production.add_argument("--at", help="ISO timestamp used as issue time, mainly for tests/backfill")

    actual = sub.add_parser("actual", help="Store actual generation for a day")
    actual.add_argument("date", help="Actual generation date, YYYY-MM-DD")
    actual.add_argument("--total", type=float, help="Daily actual generation in kWh")
    actual.add_argument("--hourly", help="24 hourly kWh values separated by spaces, commas, semicolons, or newlines")
    actual.add_argument("--hourly-file", type=Path, help="File containing 24 hourly kWh values")
    actual.add_argument("--source", default="manual", help="Actuals source label")
    actual.add_argument("--notes", default="", help="Optional notes")

    sub.add_parser("list", help="List forecast-vs-actual comparisons as JSON")

    args = parser.parse_args()
    con = connect()
    init_db(con)

    if args.command == "init-db":
        print("Initialized", con.execute("PRAGMA database_list").fetchone()[2])
        return

    if args.command == "capture":
        issued_at = parse_issue_time(args.at) if args.at else None
        snapshot = capture_day_ahead_forecast(now=issued_at)
        run_id = save_forecast_run(con, snapshot)
        print(json.dumps({"forecast_run_id": run_id, **snapshot}, indent=2))
        return

    if args.command == "capture-today":
        issued_at = parse_issue_time(args.at) if args.at else None
        snapshot = capture_same_day_forecast(now=issued_at)
        run_id = save_forecast_run(con, snapshot)
        print(json.dumps({"forecast_run_id": run_id, **snapshot}, indent=2))
        return

    if args.command == "capture-dwd":
        issued_at = parse_issue_time(args.at) if args.at else None
        snapshot = capture_dwd_day_ahead_forecast(now=issued_at)
        run_id = save_forecast_run(con, snapshot)
        print(json.dumps({"forecast_run_id": run_id, **snapshot}, indent=2))
        return

    if args.command == "capture-dwd-today":
        issued_at = parse_issue_time(args.at) if args.at else None
        snapshot = capture_dwd_same_day_forecast(now=issued_at)
        run_id = save_forecast_run(con, snapshot)
        print(json.dumps({"forecast_run_id": run_id, **snapshot}, indent=2))
        return

    if args.command == "capture-production":
        issued_at = parse_issue_time(args.at) if args.at else None
        snapshots = capture_production_day_ahead_forecasts(now=issued_at)
        run_ids = [save_forecast_run(con, snapshot) for snapshot in snapshots]
        print(json.dumps({"forecast_run_ids": run_ids, "production": {"forecast_run_id": run_ids[-1], **snapshots[-1]}}, indent=2))
        return

    if args.command == "actual":
        hourly_text = ""
        if args.hourly_file:
            hourly_text = args.hourly_file.read_text(encoding="utf-8")
        elif args.hourly:
            hourly_text = args.hourly
        hourly = parse_hourly_values(hourly_text) if hourly_text else []
        save_actual(con, args.date, args.total, hourly, args.source, args.notes)
        print(json.dumps({"saved": True, "date": args.date, "hourly_points": len(hourly)}, indent=2))
        return

    if args.command == "list":
        print(json.dumps(list_comparisons(con), indent=2))


def parse_issue_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(LOCATION["timezone"]))
    return parsed


if __name__ == "__main__":
    main()
