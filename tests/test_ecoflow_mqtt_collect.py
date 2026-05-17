import importlib.util
import sqlite3
import struct
import unittest
from pathlib import Path

from history_app.database import init_db


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ecoflow_mqtt_collect.py"
SPEC = importlib.util.spec_from_file_location("ecoflow_mqtt_collect", MODULE_PATH)
ecoflow_mqtt_collect = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ecoflow_mqtt_collect)


class EcoFlowMQTTCollectTest(unittest.TestCase):
    def test_decode_publish_extracts_topic_payload_and_packet_id(self):
        topic = "/open/account/HJ31/quota"
        payload = b'{"mpptPwr": 1200, "bpSoc": 54}'
        body = struct.pack("!H", len(topic)) + topic.encode() + struct.pack("!H", 9) + payload

        decoded_topic, decoded_payload, packet_id = ecoflow_mqtt_collect.decode_publish(0x32, body)

        self.assertEqual(decoded_topic, topic)
        self.assertEqual(decoded_payload, payload)
        self.assertEqual(packet_id, 9)

    def test_tick_from_payload_maps_powerocean_fields(self):
        tick = ecoflow_mqtt_collect.tick_from_payload(
            "/open/account/HJ31/quota",
            {"mpptPwr": 1200, "bpSoc": 54, "bpPwr": -100, "sysLoadPwr": 300, "sysGridPwr": 0},
            {"HJ31": "PowerOcean"},
        )

        self.assertEqual(tick["device_sn"], "HJ31")
        self.assertEqual(tick["device_name"], "PowerOcean")
        self.assertEqual(tick["solar_power_w"], 1200)
        self.assertEqual(tick["battery_soc_percent"], 54)

    def test_tick_from_payload_carries_previous_values_for_partial_updates(self):
        tick = ecoflow_mqtt_collect.tick_from_payload(
            "/open/account/HJ31/quota",
            {"bpSoc": 87},
            {"HJ31": "PowerOcean"},
            {"solar_power_w": 1310, "battery_soc_percent": 86, "load_power_w": 400},
        )

        self.assertEqual(tick["solar_power_w"], 1310)
        self.assertEqual(tick["battery_soc_percent"], 87)
        self.assertIsNone(tick["load_power_w"])
        self.assertEqual(tick["_fresh_fields"], ["battery_soc_percent"])
        self.assertEqual(tick["_carried_fields"], ["solar_power_w"])

    def test_rest_refresh_persists_load_and_grid_snapshot(self):
        class FakeClient:
            def all_quotas(self, serial_number):
                self.serial_number = serial_number
                return {
                    "mpptPwr": 1500,
                    "mpptHeartBeat": [{"mpptPv": [{"pwr": 1900}, {"pwr": 2000}]}],
                    "ems_change_report.bpSoc": 88,
                    "ems_change_report.updateTime": "2026-05-17 12:34:56",
                    "bpPwr": 700,
                    "sysLoadPwr": 420,
                    "sysGridPwr": -30,
                }

        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        init_db(con)
        state = {}

        ecoflow_mqtt_collect.refresh_rest_snapshots(
            con,
            FakeClient(),
            [{"sn": "HJ31", "deviceName": "PowerOcean"}],
            state,
        )

        row = con.execute("SELECT * FROM ecoflow_ticks").fetchone()
        self.assertEqual(row["topic"], "rest:/iot-open/sign/device/quota/all")
        self.assertEqual(row["solar_power_w"], 3900)
        self.assertEqual(row["load_power_w"], 420)
        self.assertEqual(row["grid_power_w"], -30)
        self.assertEqual(row["source_timestamp"], "2026-05-17 12:34:56")
        self.assertEqual(state["HJ31"]["load_power_w"], 420)


if __name__ == "__main__":
    unittest.main()
