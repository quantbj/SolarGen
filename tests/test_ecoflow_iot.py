import unittest
from datetime import date, timezone

from ecoflow.client import format_ecoflow_time, local_day_to_utc_range, sign_request
from ecoflow.metrics import summarize_current


class EcoFlowIoTTest(unittest.TestCase):
    def test_signature_matches_official_documentation_example(self):
        params = {
            "sn": "123456789",
            "params": {
                "cmdSet": 11,
                "id": 24,
                "eps": 0,
            },
        }

        signature = sign_request(
            params,
            "Fp4SvIprYSDPXtYJidEtUAd1o",
            "WIbFEKre0s6sLnh4ei7SPUeYnptHG6V",
            "345164",
            "1671171709428",
        )

        self.assertEqual(signature, "07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e")

    def test_local_day_to_utc_range_uses_configured_timezone(self):
        start, end = local_day_to_utc_range(date(2026, 5, 17), "Europe/Berlin")

        self.assertEqual(start.tzinfo, timezone.utc)
        self.assertEqual(end.tzinfo, timezone.utc)
        self.assertEqual(format_ecoflow_time(start), "2026-05-16 22:00:00")
        self.assertEqual(format_ecoflow_time(end), "2026-05-17 21:59:59")

    def test_current_summary_detects_powerocean_fields(self):
        summary = summarize_current({
            "mpptPwr": 321.5,
            "bpSoc": 84,
            "bpPwr": -120,
            "sysLoadPwr": 450,
            "sysGridPwr": -30,
        })

        self.assertEqual(summary["solar_power_w"]["value"], 321.5)
        self.assertEqual(summary["battery_soc_percent"]["value"], 84)
        self.assertEqual(summary["battery_power_w"]["source"], "bpPwr")

    def test_current_summary_prefers_live_ems_soc_and_derives_details(self):
        summary = summarize_current({
            "mpptPwr": 1310,
            "bpSoc": 65,
            "ems_change_report.bpSoc": 88,
            "mpptHeartBeat": [
                {"mpptPv": [{"pwr": 1946.1, "vol": 385.1, "amp": 5.05}, {"pwr": 1186.1, "vol": 268.7, "amp": 4.41}]}
            ],
            "bp_addr.pack1": '{"bpSoc": 88, "bpPwr": 1675.5, "bpRemainWatth": 4505.6}',
            "bp_addr.pack2": '{"bpSoc": 86, "bpPwr": 1590.9, "bpRemainWatth": 4400.0}',
        })

        self.assertEqual(summary["battery_soc_percent"]["value"], 88)
        self.assertEqual(summary["battery_soc_percent"]["source"], "ems_change_report.bpSoc")
        self.assertAlmostEqual(summary["solar_power_w"]["value"], 3132.2, places=1)
        self.assertEqual(summary["solar_power_w"]["source"], "mpptHeartBeat[].mpptPv[].pwr")
        self.assertAlmostEqual(summary["pv_string_power_w"]["value"], 3132.2, places=1)
        self.assertEqual(summary["battery_module_soc_percent"]["value"], 87)


if __name__ == "__main__":
    unittest.main()
