import importlib.util
import sqlite3
import unittest
from pathlib import Path

from history_app.database import init_db


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ecoflow_api_poll_collect.py"
SPEC = importlib.util.spec_from_file_location("ecoflow_api_poll_collect", MODULE_PATH)
ecoflow_api_poll_collect = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ecoflow_api_poll_collect)


class EcoFlowApiPollCollectTest(unittest.TestCase):
    def test_poll_once_persists_current_generation_soc_load_and_grid(self):
        class FakeClient:
            def all_quotas(self, serial_number):
                self.serial_number = serial_number
                return {
                    "mpptHeartBeat": [{"mpptPv": [{"pwr": 1700}, {"pwr": 1800}]}],
                    "ems_change_report.bpSoc": 76,
                    "ems_change_report.updateTime": "2026-05-17 12:34:56",
                    "bpPwr": -220,
                    "sysLoadPwr": 510,
                    "sysGridPwr": -40,
                }

        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        init_db(con)

        saved = ecoflow_api_poll_collect.poll_once(
            con,
            FakeClient(),
            [{"sn": "HJ31", "deviceName": "PowerOcean"}],
        )

        self.assertEqual(len(saved), 1)
        row = con.execute("SELECT * FROM ecoflow_ticks").fetchone()
        self.assertEqual(row["topic"], "rest:/iot-open/sign/device/quota/all")
        self.assertEqual(row["solar_power_w"], 3500)
        self.assertEqual(row["battery_soc_percent"], 76)
        self.assertEqual(row["load_power_w"], 510)
        self.assertEqual(row["grid_power_w"], -40)
        self.assertEqual(row["source_timestamp"], "2026-05-17 12:34:56")
        self.assertEqual(saved[0][1]["_metric_sources"]["load_power_w"], "sysLoadPwr")
        self.assertEqual(saved[0][1]["_metric_sources"]["grid_power_w"], "sysGridPwr")


if __name__ == "__main__":
    unittest.main()
