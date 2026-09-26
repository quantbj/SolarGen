import sqlite3
import tempfile
import unittest
from pathlib import Path

from telemetry_app.collector import battery_temperature, parse_battery, parse_disk_activity, parse_memory_pressure, parse_size, parse_thermal_pressure, parse_top
from telemetry_app.database import history, init_db, latest, save_sample


class CollectorTests(unittest.TestCase):
    def test_parse_top(self):
        parsed = parse_top("CPU usage: 3.23% user, 13.30% sys, 83.45% idle\nPhysMem: 23G used (1G wired), 2G unused.\nDisks: 10/2T read, 20/512G written.")
        self.assertAlmostEqual(parsed["cpu_percent"], 16.53)
        self.assertAlmostEqual(parsed["memory_percent"], 92)
        self.assertEqual(parsed["disk_read_bytes"], 2 * 1024**4)

    def test_parse_battery_and_thermal(self):
        self.assertEqual(parse_battery("80%; AC attached; not charging")["battery_state"], "On AC")
        self.assertEqual(parse_thermal_pressure("No thermal warning level has been recorded"), "Nominal")

    def test_temperature_and_size_parsing(self):
        self.assertEqual(battery_temperature('"Temperature" = 3026'), 29.5)
        self.assertEqual(parse_size("1.5G"), 1.5 * 1024**3)

    def test_pressure_and_disk_activity(self):
        self.assertEqual(parse_memory_pressure("System-wide memory free percentage: 64%"), 36)
        output = "disk0 disk4\nKB/t tps MB/s KB/t tps MB/s\n50 55 2.72 12 0 0.01\n18 1011 18.03 0 0 0.00"
        self.assertEqual(parse_disk_activity(output), 18.03 * 1024**2)


class DatabaseTests(unittest.TestCase):
    def test_round_trip(self):
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        init_db(con)
        sample = {
            "recorded_at": 4102444800, "cpu_percent": 10, "cpu_load_1m": 8, "cpu_load_5m": 7,
            "memory_percent": 50, "disk_percent": 20, "disk_activity_bps": 3,
            "cpu_temperature_c": None, "battery_temperature_c": 30.1, "thermal_pressure": "Nominal",
            "battery_percent": 80, "battery_state": "On AC",
        }
        save_sample(con, sample)
        self.assertEqual(latest(con)["battery_percent"], 80)
        self.assertEqual(len(history(con, 168)), 1)


if __name__ == "__main__":
    unittest.main()
