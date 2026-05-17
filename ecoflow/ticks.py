from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from history_app.ecoflow_store import save_ecoflow_tick

from .client import EcoFlowClient
from .metrics import summarize_current


TICK_FIELDS = ["solar_power_w", "battery_soc_percent", "battery_power_w", "load_power_w", "grid_power_w"]
CARRY_FORWARD_FIELDS = {"solar_power_w", "battery_soc_percent"}
TIMESTAMP_KEYS = [
    "ems_change_report.updateTime",
    "ems_edev_sys.updateTime",
    "bp_addr.updateTime",
]


def metric_value(current: dict[str, Any], key: str) -> float | None:
    if key not in current:
        return None
    try:
        return float(current[key]["value"])
    except (TypeError, ValueError):
        return None


def current_snapshot(client: EcoFlowClient, device: dict[str, Any]) -> dict[str, Any] | None:
    serial = device["sn"]
    quotas = client.all_quotas(serial)
    current = summarize_current(quotas)
    if not current:
        return None
    return {
        "received_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "device_sn": serial,
        "device_name": device.get("deviceName", ""),
        "topic": "rest:/iot-open/sign/device/quota/all",
        "source_timestamp": quota_source_timestamp(quotas),
        "solar_power_w": metric_value(current, "solar_power_w"),
        "battery_soc_percent": metric_value(current, "battery_soc_percent"),
        "battery_power_w": metric_value(current, "battery_power_w"),
        "load_power_w": metric_value(current, "load_power_w"),
        "grid_power_w": metric_value(current, "grid_power_w"),
        "raw": quotas,
        "_fresh_fields": sorted(current),
        "_carried_fields": [],
        "_metric_sources": metric_sources(current),
    }


def tick_from_payload(
    topic: str,
    payload: dict[str, Any],
    device_names: dict[str, str],
    previous_tick: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    topic_sn = extract_topic_sn(topic)
    params = payload.get("params") if isinstance(payload.get("params"), dict) else payload
    if not isinstance(params, dict):
        return None
    current = summarize_current(params)
    if not current and topic_sn:
        current = summarize_current(payload)
    if not current:
        return None

    received_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    source_ts = payload.get("timestamp") or payload.get("time") or params.get("timestamp") or params.get("time")
    fresh_fields = set()
    tick = {
        "received_at": received_at,
        "device_sn": topic_sn or payload.get("sn") or params.get("sn") or "unknown",
        "device_name": device_names.get(topic_sn, ""),
        "topic": topic,
        "source_timestamp": str(source_ts) if source_ts is not None else None,
        "solar_power_w": metric_value(current, "solar_power_w"),
        "battery_soc_percent": metric_value(current, "battery_soc_percent"),
        "battery_power_w": metric_value(current, "battery_power_w"),
        "load_power_w": metric_value(current, "load_power_w"),
        "grid_power_w": metric_value(current, "grid_power_w"),
        "raw": payload,
    }
    for field in TICK_FIELDS:
        if tick.get(field) is not None:
            fresh_fields.add(field)
    carried_fields = []
    if previous_tick:
        for field in CARRY_FORWARD_FIELDS:
            if tick.get(field) is None and previous_tick.get(field) is not None:
                tick[field] = previous_tick[field]
                carried_fields.append(field)
    tick["_fresh_fields"] = sorted(fresh_fields)
    tick["_carried_fields"] = carried_fields
    return tick


def metric_sources(current: dict[str, Any]) -> dict[str, str]:
    return {
        key: str(current[key]["source"])
        for key in TICK_FIELDS
        if key in current and current[key].get("source") is not None
    }


def quota_source_timestamp(quotas: dict[str, Any]) -> str | None:
    for key in TIMESTAMP_KEYS:
        value = quotas.get(key)
        if value:
            return str(value)
    candidates = [
        str(value)
        for key, value in quotas.items()
        if key.endswith("updateTime") and value
    ]
    return max(candidates) if candidates else None


def persist_current_snapshot(con, client: EcoFlowClient, device: dict[str, Any]) -> tuple[int, dict[str, Any]] | None:
    tick = current_snapshot(client, device)
    if not tick:
        return None
    return save_ecoflow_tick(con, tick), tick


def select_devices(devices: list[dict[str, Any]], serial_numbers: list[str] | None) -> list[dict[str, Any]]:
    if not serial_numbers:
        return devices
    wanted = set(serial_numbers)
    selected = [device for device in devices if device.get("sn") in wanted]
    missing = sorted(wanted - {device.get("sn") for device in selected})
    if missing:
        raise SystemExit(f"Requested serial number(s) not found: {', '.join(missing)}")
    return selected


def extract_topic_sn(topic: str) -> str:
    parts = topic.strip("/").split("/")
    return parts[2] if len(parts) >= 3 else ""


def parse_payload(payload: bytes) -> dict[str, Any] | None:
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None
