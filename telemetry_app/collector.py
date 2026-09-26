from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path


NUMBER = r"([0-9]+(?:\.[0-9]+)?)"


def run(command: list[str], timeout: float = 3.0) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout if result.returncode == 0 else ""


def parse_size(value: str) -> float:
    match = re.fullmatch(r"\s*([0-9.]+)\s*([KMGTPE]?)\s*", value, re.IGNORECASE)
    if not match:
        return 0.0
    powers = {"": 0, "K": 1, "M": 2, "G": 3, "T": 4, "P": 5, "E": 6}
    return float(match.group(1)) * 1024 ** powers[match.group(2).upper()]


def parse_top(output: str) -> dict[str, float]:
    values: dict[str, float] = {}
    cpu = re.search(rf"CPU usage:\s*{NUMBER}% user,\s*{NUMBER}% sys,\s*{NUMBER}% idle", output)
    if cpu:
        values["cpu_percent"] = min(100.0, float(cpu.group(1)) + float(cpu.group(2)))

    memory = re.search(r"PhysMem:\s*([^ ]+) used.*?,\s*([^ ]+) unused", output)
    if memory:
        used = parse_size(memory.group(1))
        unused = parse_size(memory.group(2))
        if used + unused:
            values["memory_percent"] = used * 100 / (used + unused)

    disks = re.search(r"Disks:\s*[0-9]+/([^ ]+) read,\s*[0-9]+/([^ ]+) written", output)
    if disks:
        values["disk_read_bytes"] = parse_size(disks.group(1))
        values["disk_write_bytes"] = parse_size(disks.group(2))
    return values


def parse_battery(output: str) -> dict[str, object]:
    percent = re.search(r"(\d+)%", output)
    if not percent:
        return {"battery_percent": None, "battery_state": "Unavailable"}
    lowered = output.lower()
    if "charging" in lowered and "not charging" not in lowered:
        state = "Charging"
    elif "ac attached" in lowered or "charged" in lowered:
        state = "On AC"
    else:
        state = "On battery"
    return {"battery_percent": int(percent.group(1)), "battery_state": state}


def parse_thermal_pressure(output: str) -> str:
    lowered = output.lower()
    if "critical" in lowered:
        return "Critical"
    if "heavy" in lowered:
        return "Heavy"
    if "moderate" in lowered or "warning level" in lowered and "no thermal warning" not in lowered:
        return "Moderate"
    return "Nominal" if "no thermal warning" in lowered else "Unknown"


def parse_memory_pressure(output: str) -> float | None:
    match = re.search(r"System-wide memory free percentage:\s*(\d+)%", output)
    return 100 - float(match.group(1)) if match else None


def parse_disk_activity(output: str) -> float:
    rows = [line.split() for line in output.splitlines() if re.match(r"^\s*[0-9]", line)]
    if not rows:
        return 0.0
    # The last iostat row is the current interval; every third column is MB/s.
    values = rows[-1]
    return sum(float(values[index]) for index in range(2, len(values), 3)) * 1024 * 1024


def battery_temperature(output: str) -> float | None:
    match = re.search(r'"Temperature"\s*=\s*(\d+)', output)
    if not match:
        return None
    raw = int(match.group(1))
    # AppleSmartBattery reports decikelvin (for example 3026 = 29.5 C).
    value = raw / 10 - 273.15
    return round(value, 1) if -20 <= value <= 100 else None


def cpu_temperature() -> float | None:
    helper = os.environ.get("TELEMETRY_TEMPERATURE_COMMAND", "").strip()
    command = shlex.split(helper) if helper else (["osx-cpu-temp"] if shutil.which("osx-cpu-temp") else [])
    if not command:
        return None
    match = re.search(r"(-?[0-9]+(?:\.[0-9]+)?)", run(command))
    if not match:
        return None
    value = float(match.group(1))
    return round(value, 1) if -20 <= value <= 150 else None


class Collector:
    def collect(self) -> dict[str, object]:
        now = time.time()
        top = parse_top(run(["top", "-l", "1", "-n", "0"], timeout=5))
        pressure_memory = parse_memory_pressure(run(["memory_pressure", "-Q"]))
        disk_activity = parse_disk_activity(run(["iostat", "-d", "-w", "1", "-c", "2"], timeout=4))
        usage = shutil.disk_usage(Path.home())
        battery = parse_battery(run(["pmset", "-g", "batt"]))
        battery_ioreg = run(["ioreg", "-rn", "AppleSmartBattery"])
        load_1, load_5, load_15 = os.getloadavg()
        cpu_count = os.cpu_count() or 1
        return {
            "recorded_at": int(now),
            "cpu_percent": round(float(top.get("cpu_percent", 0.0)), 1),
            "cpu_load_1m": round(load_1 / cpu_count * 100, 1),
            "cpu_load_5m": round(load_5 / cpu_count * 100, 1),
            "memory_percent": round(pressure_memory if pressure_memory is not None else float(top.get("memory_percent", 0.0)), 1),
            "disk_percent": round(usage.used * 100 / usage.total, 1),
            "disk_activity_bps": round(disk_activity),
            "cpu_temperature_c": cpu_temperature(),
            "battery_temperature_c": battery_temperature(battery_ioreg),
            "thermal_pressure": parse_thermal_pressure(run(["pmset", "-g", "therm"])),
            **battery,
        }
