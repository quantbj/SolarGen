#!/usr/bin/env python3
"""Poll EcoFlow REST quota snapshots and persist them to the history DB."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from history_app.database import connect, init_db
from history_app.ecoflow_store import save_ecoflow_tick
from ecoflow.client import EcoFlowClient, load_credentials
from ecoflow.logging import format_percent, format_watts, log
from ecoflow.ticks import current_snapshot, select_devices


DEFAULT_INTERVAL_SECONDS = 5.0


def print_saved_snapshot(row_id: int, tick: dict[str, Any]) -> None:
    sources = tick.get("_metric_sources") or {}
    source_text = (
        f" sources=solar:{sources.get('solar_power_w', '?')}"
        f",soc:{sources.get('battery_soc_percent', '?')}"
        f",load:{sources.get('load_power_w', '?')}"
        f",grid:{sources.get('grid_power_w', '?')}"
    )
    api_time = f" api_time={tick['source_timestamp']}" if tick.get("source_timestamp") else ""
    log(
        f"saved api poll row={row_id} sn={tick['device_sn']} "
        f"solar={format_watts(tick.get('solar_power_w'))} "
        f"soc={format_percent(tick.get('battery_soc_percent'))} "
        f"load={format_watts(tick.get('load_power_w'))} "
        f"grid={format_watts(tick.get('grid_power_w'))}"
        f"{api_time}{source_text}"
    )


def poll_once(con, api_client: EcoFlowClient, devices: list[dict[str, Any]]) -> list[tuple[int, dict[str, Any]]]:
    """Read and save one REST quota snapshot for every selected device."""
    saved = []
    for device in devices:
        tick = current_snapshot(api_client, device)
        if tick is None:
            log(f"no known current fields returned for {device.get('sn', 'unknown')}", error=True)
            continue
        row_id = save_ecoflow_tick(con, tick)
        saved.append((row_id, tick))
        print_saved_snapshot(row_id, tick)
    return saved


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-file", default="EcoflowIoT/access.txt")
    parser.add_argument("--host", default="https://api.ecoflow.com")
    parser.add_argument("--sn", action="append", help="Device serial number. Repeat to poll multiple devices.")
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL_SECONDS, help="Seconds between API polls.")
    parser.add_argument("--retry-delay", type=float, default=10.0, help="Seconds to wait after an API error.")
    parser.add_argument("--once", action="store_true", help="Poll once and exit.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.interval <= 0:
        log("--interval must be greater than 0.", error=True)
        return 1
    if args.retry_delay < 0:
        log("--retry-delay must not be negative.", error=True)
        return 1

    access_key, secret_key = load_credentials(args.credentials_file)
    api_client = EcoFlowClient(access_key, secret_key, host=args.host)
    devices = select_devices(api_client.list_devices(), args.sn)
    if not devices:
        log("No EcoFlow devices found.", error=True)
        return 1

    con = connect()
    init_db(con)
    log(f"polling EcoFlow API every {args.interval:g}s for {len(devices)} device(s)")

    while True:
        started = time.monotonic()
        try:
            poll_once(con, api_client, devices)
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            log(f"api poll collector error: {exc}; retrying in {args.retry_delay:g}s", error=True)
            try:
                time.sleep(args.retry_delay)
            except KeyboardInterrupt:
                return 0
            continue

        if args.once:
            return 0

        elapsed = time.monotonic() - started
        try:
            time.sleep(max(0, args.interval - elapsed))
        except KeyboardInterrupt:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
