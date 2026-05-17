#!/usr/bin/env python3
"""Read EcoFlow IoT current quotas and same-day history."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ecoflow.client import (
    DEFAULT_CREDENTIALS_FILE,
    DEFAULT_HOST,
    DEFAULT_TIMEZONE,
    EcoFlowClient,
    EcoFlowError,
    format_ecoflow_time,
    load_credentials,
    local_day_to_utc_range,
)
from ecoflow.metrics import summarize_current


STREAM_HISTORY_CODES = {
    "solar_energy": "BK621-App-HOME-SOLAR-ENERGY-FLOW-solor-line-NOTDISTINGUISH-MASTER_DATA",
    "battery_energy": "BK621-App-HOME-SOC-ENERGY-FLOW-battery-prop_bar-NOTDISTINGUISH-MASTER_DATA",
}

POWEROCEAN_HISTORY_CODES = {
    "overview": "JT303_Dashboard_Overview_Summary_Week",
}


def detect_history_profiles(quotas, requested_profile):
    if requested_profile != "auto":
        return [requested_profile]
    profiles = []
    if "mpptPwr" in quotas or "bpSoc" in quotas:
        profiles.append("powerocean")
    if "powGetPvSum" in quotas or "cmsBattSoc" in quotas or "powGetBpCms" in quotas:
        profiles.append("stream")
    return profiles or ["stream", "powerocean"]


def history_codes_for_profile(profile):
    if profile == "stream":
        return STREAM_HISTORY_CODES
    if profile == "powerocean":
        return POWEROCEAN_HISTORY_CODES
    if profile == "all":
        return {**{f"stream_{key}": value for key, value in STREAM_HISTORY_CODES.items()},
                **{f"powerocean_{key}": value for key, value in POWEROCEAN_HISTORY_CODES.items()}}
    return {}


def normalize_history_rows(payload):
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    if isinstance(payload, list):
        return payload
    return payload


def collect_device(client, device, begin_utc, end_utc, profile, include_history):
    serial_number = device.get("sn")
    if not serial_number:
        return {"device": device, "error": "Device has no serial number."}

    result = {"device": device}
    quotas = client.all_quotas(serial_number)
    result["current"] = summarize_current(quotas)
    result["quota_count"] = len(quotas)
    result["raw_quotas"] = quotas

    if include_history:
        history = {}
        errors = {}
        for detected_profile in detect_history_profiles(quotas, profile):
            for name, code in history_codes_for_profile(detected_profile).items():
                key = f"{detected_profile}_{name}" if profile == "auto" else name
                try:
                    payload = client.history(serial_number, begin_utc, end_utc, code)
                    history[key] = normalize_history_rows(payload)
                except EcoFlowError as exc:
                    errors[key] = str(exc)
        result["history"] = history
        if errors:
            result["history_errors"] = errors
    return result


def select_devices(devices, serial_numbers):
    if not serial_numbers:
        return devices
    wanted = set(serial_numbers)
    selected = [device for device in devices if device.get("sn") in wanted]
    missing = sorted(wanted - {device.get("sn") for device in selected})
    if missing:
        raise EcoFlowError(f"Requested serial number(s) not found in device list: {', '.join(missing)}")
    return selected


def format_value(metric):
    value = metric["value"]
    unit = metric.get("unit")
    return f"{value} {unit}".strip() if unit else str(value)


def format_metric_detail(metric):
    details = metric.get("details")
    if not details:
        return []
    lines = []
    for item in details:
        if "soc_percent" in item:
            power = f", {item['power_w']:.0f} W" if item.get("power_w") is not None else ""
            remain = f", {item['remain_wh'] / 1000:.2f} kWh remaining" if item.get("remain_wh") is not None else ""
            lines.append(f"{item['name']}: {item['soc_percent']:.0f}%{power}{remain}")
        elif "power_w" in item:
            voltage = f", {item['voltage_v']:.1f} V" if item.get("voltage_v") is not None else ""
            current = f", {item['current_a']:.2f} A" if item.get("current_a") is not None else ""
            lines.append(f"{item['name']}: {item['power_w']:.0f} W{voltage}{current}")
    return lines


def format_history_lines(rows):
    if not isinstance(rows, list):
        return [json.dumps(rows, ensure_ascii=False)]
    lines = []
    for row in rows:
        if not isinstance(row, dict):
            lines.append(json.dumps(row, ensure_ascii=False))
            continue
        name = row.get("indexName") or row.get("name") or row.get("code") or "value"
        if "indexValue" not in row:
            continue
        extra = f" extra={row['extra']}" if row.get("extra") is not None else ""
        unit = f" {row['unit']}" if row.get("unit") else ""
        lines.append(f"{name}{extra}: {row['indexValue']}{unit}")
    return lines or [json.dumps(rows, ensure_ascii=False)]


def print_human(results, begin_utc, end_utc, raw):
    print(f"EcoFlow history window UTC: {format_ecoflow_time(begin_utc)} to {format_ecoflow_time(end_utc)}")
    for result in results:
        device = result["device"]
        serial = device.get("sn", "unknown")
        name = device.get("deviceName") or device.get("productName") or "Unnamed device"
        online = device.get("online")
        print()
        print(f"{name} ({serial}) online={online}")
        if "error" in result:
            print(f"  error: {result['error']}")
            continue

        print(f"  current quotas returned: {result.get('quota_count', 0)}")
        current = result.get("current") or {}
        if current:
            for key, metric in current.items():
                print(f"  {key}: {format_value(metric)} [{metric['source']}]")
                for line in format_metric_detail(metric):
                    print(f"    {line}")
        else:
            print("  current summary: no known solar/battery fields found")

        history = result.get("history") or {}
        if history:
            print("  today's history:")
            for key, rows in history.items():
                print(f"    {key}:")
                for line in format_history_lines(rows):
                    print(f"      {line}")
        if result.get("history_errors"):
            print("  history errors:")
            for key, error in result["history_errors"].items():
                print(f"    {key}: {error}")
        if raw:
            print("  raw quotas:")
            print(json.dumps(result.get("raw_quotas", {}), indent=2, ensure_ascii=False, sort_keys=True))


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-file", default=str(DEFAULT_CREDENTIALS_FILE))
    parser.add_argument("--host", default=os.environ.get("ECOFLOW_API_HOST", DEFAULT_HOST))
    parser.add_argument("--sn", action="append", help="Device serial number. Repeat to select multiple devices.")
    parser.add_argument("--date", default=date.today().isoformat(), help="Local history date, YYYY-MM-DD.")
    parser.add_argument("--timezone", default=os.environ.get("TZ", DEFAULT_TIMEZONE))
    parser.add_argument("--history-profile", choices=["auto", "stream", "powerocean", "all"], default="auto")
    parser.add_argument("--no-history", action="store_true", help="Only read current quota state.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    parser.add_argument("--raw", action="store_true", help="Include raw quota data in human output.")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    try:
        history_day = date.fromisoformat(args.date)
        begin_utc, end_utc = local_day_to_utc_range(history_day, args.timezone)
        access_key, secret_key = load_credentials(args.credentials_file)
        client = EcoFlowClient(access_key, secret_key, host=args.host)
        devices = select_devices(client.list_devices(), args.sn)
        results = [
            collect_device(client, device, begin_utc, end_utc, args.history_profile, not args.no_history)
            for device in devices
        ]
        if args.json:
            public_results = []
            for result in results:
                item = dict(result)
                if not args.raw:
                    item.pop("raw_quotas", None)
                public_results.append(item)
            print(json.dumps({
                "history_window_utc": {
                    "begin": format_ecoflow_time(begin_utc),
                    "end": format_ecoflow_time(end_utc),
                },
                "devices": public_results,
            }, indent=2, ensure_ascii=False, sort_keys=True))
        else:
            print_human(results, begin_utc, end_utc, args.raw)
    except (EcoFlowError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
