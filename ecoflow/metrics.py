from __future__ import annotations

import json


CURRENT_FIELDS = {
    "solar_power_w": {
        "keys": ["mpptPwr", "powGetPvSum", "pvInputWatts", "inv.inputWatts"],
        "sum_keys": [["pv1InputWatts", "pv2InputWatts"]],
        "unit": "W",
    },
    "battery_soc_percent": {
        "keys": ["ems_change_report.bpSoc", "ems_edev_sys.socCur", "bpSoc", "cmsBattSoc", "batSoc", "pd.soc"],
        "unit": "%",
    },
    "battery_power_w": {
        "keys": ["bpPwr", "powGetBpCms", "batInputWatts"],
        "unit": "W",
    },
    "load_power_w": {
        "keys": ["sysLoadPwr", "powGetSysLoad"],
        "unit": "W",
    },
    "grid_power_w": {
        "keys": ["sysGridPwr", "gridConnectionPower", "powGetSysGrid"],
        "unit": "W",
    },
}

EXTRA_CURRENT_FIELDS = {
    "pv_string_power_w": {"unit": "W"},
    "battery_module_soc_percent": {"unit": "%"},
}


def summarize_current(quotas):
    summary = {}
    for name, field in CURRENT_FIELDS.items():
        source, value = first_present(quotas, field.get("keys", []))
        if source is None:
            for sum_keys in field.get("sum_keys", []):
                if all(key in quotas for key in sum_keys):
                    source = "+".join(sum_keys)
                    value = sum(number_or_zero(quotas[key]) for key in sum_keys)
                    break
        if source is not None:
            summary[name] = {
                "value": value,
                "unit": field.get("unit"),
                "source": source,
            }
    derived_pv = pv_string_power(quotas)
    if derived_pv is not None:
        summary["solar_power_w"] = {
            "value": derived_pv["total_power_w"],
            "unit": "W",
            "source": derived_pv["source"],
        }
    for name, field in EXTRA_CURRENT_FIELDS.items():
        if name == "pv_string_power_w" and derived_pv is not None:
            summary[name] = {
                "value": derived_pv["total_power_w"],
                "unit": field["unit"],
                "source": derived_pv["source"],
                "details": derived_pv["strings"],
            }
        if name == "battery_module_soc_percent":
            derived = battery_module_soc(quotas)
            if derived is not None:
                summary[name] = {
                    "value": derived["average_soc_percent"],
                    "unit": field["unit"],
                    "source": derived["source"],
                    "details": derived["modules"],
                }
    return summary


def first_present(quotas, keys):
    for key in keys:
        if key in quotas:
            return key, quotas[key]
    return None, None


def pv_string_power(quotas):
    heartbeats = quotas.get("mpptHeartBeat")
    if not isinstance(heartbeats, list):
        return None
    strings = []
    for heartbeat_index, heartbeat in enumerate(heartbeats):
        if not isinstance(heartbeat, dict):
            continue
        for string_index, pv in enumerate(heartbeat.get("mpptPv") or []):
            if not isinstance(pv, dict):
                continue
            power = number_or_none(pv.get("pwr"))
            if power is None:
                continue
            strings.append({
                "name": f"MPPT {heartbeat_index + 1}.{string_index + 1}",
                "power_w": power,
                "voltage_v": number_or_none(pv.get("vol")),
                "current_a": number_or_none(pv.get("amp")),
            })
    if not strings:
        return None
    return {
        "source": "mpptHeartBeat[].mpptPv[].pwr",
        "total_power_w": round(sum(item["power_w"] for item in strings), 3),
        "strings": strings,
    }


def battery_module_soc(quotas):
    modules = []
    for key, value in quotas.items():
        if not key.startswith("bp_addr.") or key == "bp_addr.updateTime":
            continue
        parsed = parse_json_object(value)
        if not parsed:
            continue
        soc = number_or_none(parsed.get("bpSoc") if parsed.get("bpSoc") is not None else parsed.get("bpRealSoc"))
        if soc is None:
            continue
        modules.append({
            "name": key.removeprefix("bp_addr."),
            "soc_percent": soc,
            "power_w": number_or_none(parsed.get("bpPwr")),
            "remain_wh": number_or_none(parsed.get("bpRemainWatth")),
        })
    if not modules:
        return None
    return {
        "source": "bp_addr.*.bpSoc",
        "average_soc_percent": round(sum(item["soc_percent"] for item in modules) / len(modules), 2),
        "modules": modules,
    }


def parse_json_object(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def number_or_none(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def number_or_zero(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
